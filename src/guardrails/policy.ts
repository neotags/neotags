export interface Policy {
  allowedChannels: string[];
  allowedUsers: string[];
}

export type Decision = { ok: true } | { ok: false; reason: string };

/** Channel/user allowlists; empty list means "no restriction". */
export function authorize(p: Policy, channel: string, user: string): Decision {
  if (p.allowedChannels.length && !p.allowedChannels.includes(channel))
    return { ok: false, reason: "this channel is not enabled for me" };
  if (p.allowedUsers.length && !p.allowedUsers.includes(user))
    return { ok: false, reason: "you are not allowed to use me" };
  return { ok: true };
}
