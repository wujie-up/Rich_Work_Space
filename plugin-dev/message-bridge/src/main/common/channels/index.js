import { FeishuChannel } from './feishu.js';
import { WechatChannel } from './wechat.js';
import { WeixinBotChannel } from './weixin-bot.js';

const channels = { feishu: FeishuChannel, wechat: WechatChannel, 'weixin-bot': WeixinBotChannel };
export const channelFactory = options => new channels[options.channel.type](options);
