import type { ChannelType } from '#lib/notify.ts';
import type { ChannelAdapter } from './adapter.ts';
import { discord } from './discord.ts';
import { email } from './email.ts';
import { gotify } from './gotify.ts';
import { homeassistant } from './homeassistant.ts';
import { matrix } from './matrix.ts';
import { ntfy } from './ntfy.ts';
import { pushover } from './pushover.ts';
import { slack } from './slack.ts';
import { telegram } from './telegram.ts';
import { webhook } from './webhook.ts';

export const ADAPTERS: Record<ChannelType, ChannelAdapter> = { ntfy, discord, slack, telegram, pushover, gotify, matrix, email, homeassistant, webhook };
export type { ChannelAdapter, SendContext } from './adapter.ts';
