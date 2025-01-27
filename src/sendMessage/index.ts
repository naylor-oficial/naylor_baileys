import { AnyMessageContent, delay } from "@whiskeysockets/baileys";
import Sock from "../..";

class Send extends Sock {

    constructor() {
        super();
    }

    private async Typing(jid: string) {
        await this.sock.presenceSubscribe(jid)
        await delay(500)
        await this.sock.sendPresenceUpdate('composing', jid)
        await delay(2000)
        await this.sock.sendPresenceUpdate('paused', jid)
    }


    public async sendText(msg: AnyMessageContent, jid: string) {
        this.Typing(jid);
        await this.sock.sendMessage(jid, msg)
    }
}