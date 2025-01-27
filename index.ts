import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, {
	AnyMessageContent, BinaryInfo, delay, DisconnectReason,
	downloadAndProcessHistorySyncNotification, downloadMediaMessage, encodeWAM, fetchLatestBaileysVersion,
	getAggregateVotesInPollMessage, getContentType, getHistoryMsg, isJidNewsletter, makeCacheableSignalKeyStore,
	makeInMemoryStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey
} from '@whiskeysockets/baileys'
import fs from 'fs'
import P from 'pino'

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)


class Sock {
	//Objetos 
	public sock: any;
	public msg: any;
	private event: any;

	// start a connection
	private async Main() {
		const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
		// fetch latest version of WA Web
		const { version, isLatest } = await fetchLatestBaileysVersion()
		console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

		this.sock = makeWASocket({
			version,
			logger,
			printQRInTerminal: usePairingCode,
			auth: {
				creds: state.creds,
				/** caching makes the store faster to send/recv messages */
				keys: makeCacheableSignalKeyStore(state.keys, logger),
			},
			msgRetryCounterCache,
			generateHighQualityLinkPreview: true,
			// ignore all broadcast messages -- to receive the same
			// comment the line below out
			// shouldIgnoreJid: jid => isJidBroadcast(jid),
			// implement to handle retries & poll updates
			getMessage: this.getMessage,
		})

		store?.bind(this.sock.ev)

		// Pairing code for Web clients
		if (usePairingCode && !this.sock.authState.creds.registered) {
			// todo move to QR event
			const phoneNumber = await question('Please enter your phone number:\n')
			const code = await this.sock.requestPairingCode(phoneNumber)
			console.log(`Pairing code: ${code}`)
		}

		this.sock.ev.on('connection.update', async (update: any) => {
			const { connection, lastDisconnect } = update
			if (connection === 'close') {
				// reconnect if not logged out
				if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
					this.Main();
				} else {
					console.log('Connection closed. You are logged out.')
				}
			}

			const sendWAMExample = false;
			if (connection === 'open' && sendWAMExample) {
				/// sending WAM EXAMPLE
				const {
					header: {
						wamVersion,
						eventSequenceNumber,
					},
					events,
				} = JSON.parse(await fs.promises.readFile("./boot_analytics_test.json", "utf-8"))

				const binaryInfo = new BinaryInfo({
					protocolVersion: wamVersion,
					sequence: eventSequenceNumber,
					events: events
				})

				const buffer = encodeWAM(binaryInfo);

				const result = await this.sock.sendWAMBuffer(buffer)
				console.log(result)
			}

			console.log('connection update', update)
		})

		// credentials updated -- save them
		this.sock.ev.on('creds.update', saveCreds)

		this.Message();
	}


	private async Message() {
		this.sock.ev.on('messages.upsert', async ({ messages }) => {
			console.log('recv messages ', JSON.stringify(messages, undefined, 2))
			this.msg = messages;
			if (!this.msg.message) return // if there is no text or media message
			this.event = getContentType(this.msg); // get what type of message it is (text, image, video...)
			const text = this.msg.message?.conversation || this.msg.message?.extendedTextMessage?.text
			this.Text(text, messages)
			this.Media();
		});

		// messages updated like status delivered, message deleted etc.
		this.sock.ev.on('messages.update', async (event: any) => {
			console.log(JSON.stringify(event, undefined, 2))
			for (const { key, update } of event) {
				if (update.pollUpdates) {
					const pollCreation = await this.getMessage(key)
					if (pollCreation) {
						console.log(
							'got poll update, aggregation: ',
							getAggregateVotesInPollMessage({
								message: pollCreation,
								pollUpdates: update.pollUpdates,
							})
						)
					}
				}
			}
		})

		this.sock.ev.on('message-receipt.update', (event: any) => {
			console.log(event)
		});

		this.sock.ev.on('messages.reaction', (event: any) => {
			console.log(event)
		});


		return this.sock
	}


	private async getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}

	private async Text(text: any, messages: any) {

		if (text == "requestPlaceholder" && !messages.requestId) {
			const messageId = await this.sock.requestPlaceholderResend(this.msg.key)
			console.log('requested placeholder resync, id=', messageId)
		} else if (messages.requestId) {
			console.log('Message received from phone, id=', messages.requestId, this.msg)
		}
		// go to an old chat and send this
		if (text == "onDemandHistSync") {
			const messageId = await this.sock.fetchMessageHistory(50, this.msg.key, this.msg.messageTimestamp!)
			console.log('requested on-demand sync, id=', messageId)
		}

		if (!this.msg.key.fromMe && doReplies && !isJidNewsletter(this.msg.key?.remoteJid!)) {

			console.log('replying to', this.msg.key.remoteJid)
			await this.sock!.readMessages([this.msg.key])
			await this.sock.sendMessage({ text: 'Hello there!' }, this.msg.key.remoteJid!)
		}


	}

	private async Media() {
		// if the message is an image
		if (this.event === 'imageMessage') {
			if (this.event.imageMessage.caption.toLowerCase() === '#sticker') {
				// download the message
				const stream = await downloadMediaMessage(
					this.msg,
					'stream', // can be 'buffer' too
					{},
					{
						logger,
						// pass this so that baileys can request a reupload of media
						// that has been deleted
						reuploadRequest: this.sock.updateMediaMessage
					}
				)

				this.sock.sendMessage(this.msg.key.remoteJid, { sticker: { url: stream } })

			}
		}
	}



}

export default Sock; 