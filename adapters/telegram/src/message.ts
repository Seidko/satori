import { Dict, h, MessageEncoder, SendOptions } from '@satorijs/satori'
import FormData from 'form-data'
import { TelegramBot } from './bot'
import * as Telegram from './utils'

type RenderMode = 'default' | 'figure'

type AssetMethod = 'sendPhoto' | 'sendAudio' | 'sendDocument' | 'sendVideo' | 'sendAnimation' | 'sendVoice'

async function appendAsset(bot: TelegramBot, form: FormData, element: h): Promise<AssetMethod> {
  let method: AssetMethod
  const { filename, data, mime } = await bot.ctx.http.file(element.attrs.url, element.attrs)
  if (element.type === 'image') {
    method = mime === 'image/gif' ? 'sendAnimation' : 'sendPhoto'
  } else if (element.type === 'file') {
    method = 'sendDocument'
  } else if (element.type === 'video') {
    method = 'sendVideo'
  } else if (element.type === 'audio') {
    method = element.attrs.type === 'voice' ? 'sendVoice' : 'sendAudio'
  }
  // https://github.com/form-data/form-data/issues/468
  const value = process.env.KOISHI_ENV === 'browser'
    ? new Blob([data], { type: mime })
    : Buffer.from(data)
  form.append(method.slice(4).toLowerCase(), value, filename)
  return method
}

const supportedElements = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'del', 'a']

export class TelegramMessageEncoder extends MessageEncoder<TelegramBot> {
  private asset: h = null
  private payload: Dict
  private mode: RenderMode = 'default'

  constructor(bot: TelegramBot, channelId: string, guildId?: string, options?: SendOptions) {
    super(bot, channelId, guildId, options)
    const chat_id = guildId || channelId
    this.payload = { chat_id, parse_mode: 'html', caption: '' }
    if (guildId && channelId !== guildId) this.payload.message_thread_id = +channelId
  }

  async addResult(result: Telegram.Message) {
    const session = this.bot.session()
    await this.bot.adaptMessage(result, session)
    this.results.push(session)
    session.app.emit(session, 'send', session)
  }

  async sendAsset() {
    const form = new FormData()
    for (const key in this.payload) {
      form.append(key, this.payload[key].toString())
    }
    const method = await appendAsset(this.bot, form, this.asset)
    const result = await this.bot.internal[method](form as any)
    await this.addResult(result)
    delete this.payload.reply_to_message_id
    this.asset = null
    this.payload.caption = ''
  }

  async flush() {
    if (this.asset) {
      // send previous asset if there is any
      await this.sendAsset()
    } else if (this.payload.caption) {
      const result = await this.bot.internal.sendMessage({
        chat_id: this.payload.chat_id,
        text: this.payload.caption,
        parse_mode: this.payload.parse_mode,
        reply_to_message_id: this.payload.reply_to_message_id,
        message_thread_id: this.payload.message_thread_id,
        disable_web_page_preview: !this.options.linkPreview,
      })
      await this.addResult(result)
      delete this.payload.reply_to_message_id
      this.payload.caption = ''
    }
  }

  async visit(element: h) {
    const { type, attrs, children } = element
    if (type === 'text') {
      this.payload.caption += h.escape(attrs.content)
    } else if (type === 'br') {
      this.payload.caption += '\n'
    } else if (type === 'p') {
      if (!this.payload.caption.endsWith('\n')) this.payload.caption += '\n'
      await this.render(children)
    } else if (supportedElements.includes(type)) {
      this.payload.caption += element.toString()
    } else if (type === 'spl') {
      this.payload.caption += '<tg-spoiler>'
      await this.render(children)
      this.payload.caption += '</tg-spoiler>'
    } else if (type === 'code') {
      const { lang } = attrs
      this.payload.caption += `<code${lang ? ` class="language-${lang}"` : ''}>${h.escape(attrs.content)}</code>`
    } else if (type === 'at') {
      if (attrs.id) {
        this.payload.caption += `<a href="tg://user?id=${attrs.id}">@${attrs.name || attrs.id}</a>`
      }
    } else if (['image', 'audio', 'video', 'file'].includes(type)) {
      if (this.mode === 'default') {
        await this.flush()
      }
      this.asset = element
    } else if (type === 'figure') {
      await this.flush()
      this.mode = 'figure'
      await this.render(children)
      await this.flush()
      this.mode = 'default'
    } else if (type === 'quote') {
      await this.flush()
      this.payload.reply_to_message_id = attrs.id
    } else if (type === 'message') {
      if (this.mode === 'figure') {
        await this.render(children)
        this.payload.caption += '\n'
      } else {
        await this.flush()
        await this.render(children)
        await this.flush()
      }
    } else {
      await this.render(children)
    }
  }
}
