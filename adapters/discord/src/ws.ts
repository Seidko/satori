import { Adapter, Logger, Schema } from '@satorijs/satori'
import { Gateway } from './types'
import { adaptSession, decodeUser } from './utils'
import { DiscordBot } from './bot'

const logger = new Logger('discord')

export class WsClient extends Adapter.WsClient<DiscordBot> {
  _d = 0
  _ping: NodeJS.Timeout
  _sessionId = ''
  _resumeUrl: string

  async prepare() {
    if (this._resumeUrl) {
      return this.bot.http.ws(this._resumeUrl + '/?v=10&encoding=json')
    }
    const { url } = await this.bot.internal.getGatewayBot()
    return this.bot.http.ws(url + '/?v=10&encoding=json')
  }

  heartbeat() {
    logger.debug(`heartbeat d ${this._d}`)
    this.bot.socket.send(JSON.stringify({
      op: Gateway.Opcode.HEARTBEAT,
      d: this._d,
    }))
  }

  accept() {
    this.bot.socket.addEventListener('message', async ({ data }) => {
      let parsed: Gateway.Payload
      try {
        parsed = JSON.parse(data.toString())
      } catch (error) {
        return logger.warn('cannot parse message', data)
      }
      logger.debug(require('util').inspect(parsed, false, null, true))
      if (parsed.s) {
        this._d = parsed.s
      }

      // https://discord.com/developers/docs/topics/gateway#connection-lifecycle
      if (parsed.op === Gateway.Opcode.HELLO) {
        this._ping = setInterval(() => this.heartbeat(), parsed.d.heartbeat_interval)
        if (this._sessionId) {
          logger.debug('resuming')
          this.bot.socket.send(JSON.stringify({
            op: Gateway.Opcode.RESUME,
            d: {
              token: this.bot.config.token,
              session_id: this._sessionId,
              seq: this._d,
            },
          }))
        } else {
          this.bot.socket.send(JSON.stringify({
            op: Gateway.Opcode.IDENTIFY,
            d: {
              token: this.bot.config.token,
              properties: {},
              compress: false,
              intents: this.bot.config.intents,
            },
          }))
        }
      }

      if (parsed.op === Gateway.Opcode.INVALID_SESSION) {
        if (parsed.d) return
        this._sessionId = ''
        logger.warn('offline: invalid session')
        this.bot.offline()
        this.bot.socket?.close()
      }

      if (parsed.op === Gateway.Opcode.DISPATCH) {
        this.bot.ctx.emit('discord/' + parsed.t.toLowerCase().replace(/_/g, '-') as any, parsed)
        if (parsed.t === 'READY') {
          this._sessionId = parsed.d.session_id
          this._resumeUrl = parsed.d.resume_gateway_url
          const user = decodeUser(parsed.d.user)
          Object.assign(this.bot, user)
          logger.debug('session_id ' + this._sessionId)
          return this.bot.online()
        }
        if (parsed.t === 'RESUMED') {
          return this.bot.online()
        }
        const session = await adaptSession(this.bot, parsed)
        if (session) this.bot.dispatch(session)
      }

      if (parsed.op === Gateway.Opcode.RECONNECT) {
        this.bot.offline()
        logger.warn('offline: discord request reconnect')
        this.bot.socket?.close()
      }
    })

    this.bot.socket.addEventListener('close', () => {
      clearInterval(this._ping)
    })
  }
}

export namespace WsClient {
  export interface Config extends Adapter.WsClient.Config {
    intents?: number
  }

  export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
      intents: Schema.bitset(Gateway.Intent).description('需要订阅的机器人事件。').default(0
        | Gateway.Intent.GUILD_MESSAGES
        | Gateway.Intent.GUILD_MESSAGE_REACTIONS
        | Gateway.Intent.DIRECT_MESSAGES
        | Gateway.Intent.DIRECT_MESSAGE_REACTIONS
        | Gateway.Intent.MESSAGE_CONTENT),
    }).description('推送设置'),
    Adapter.WsClient.Config,
  ] as const)
}
