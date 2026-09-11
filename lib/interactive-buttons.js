// 
//   📲  ASTRAL OF THE SUN — INTERACTIVE MESSAGES LIB
//
//   Uses nativeFlowMessage (interactiveMessage) via raw Baileys
//   ✅ Works on modern WhatsApp (2024+)
//   ✅ No conn wrapper needed — works with plain makeWASocket
// 

import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
} from '@whiskeysockets/baileys'

//  Internal: the actual send logic (replaces conn.sendButton) 
async function _sendInteractive(sock, jid, content = {}, options = {}) {
  let header = {}

  let mime = null
  if (content.image)         mime = 'image'
  else if (content.video)    mime = 'video'
  else if (content.document) mime = 'document'

  if (mime) {
    const media = await prepareWAMessageMedia(
      { [mime]: content[mime] },
      { upload: sock.waUploadToServer }
    )
    header = {
      hasMediaAttachment: true,
      [`${mime}Message`]: media[`${mime}Message`],
    }
  }

  const waMsg = generateWAMessageFromContent(
    jid,
    {
      interactiveMessage: {
        header: { title: content.title || '', ...header },
        body:   { text: content.body || content.text || content.caption || '' },
        footer: { text: content.footer || '' },
        nativeFlowMessage: {
          buttons: content.buttons || [],
        },
      },
    },
    { userJid: sock.user?.id, ...options }
  )

  await sock.relayMessage(jid, waMsg.message, {
    messageId: waMsg.key.id,
    additionalNodes: [
      {
        tag:     'biz',
        attrs:   {},
        content: [
          {
            tag:     'interactive',
            attrs:   { type: 'native_flow', v: '1' },
            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
          },
        ],
      },
    ],
  })

  return waMsg
}

//  Core: quick reply buttons 
// buttons: [{ id, label }]  — max 3
// image:   Buffer (optional header image)
export async function sendButtons(ctx, { body, footer, buttons, image }) {
  const { sock, jid, msg } = ctx
  if (!buttons?.length) throw new Error('sendButtons: need at least 1 button')

  const waButtons = buttons.slice(0, 3).map(b => ({
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: b.label || '',
      id:           b.id    || '',
    }),
  }))

  return _sendInteractive(sock, jid, {
    ...(image && Buffer.isBuffer(image) ? { image } : {}),
    body,
    footer,
    buttons: waButtons,
  }, { quoted: msg })
}

//  Core: CTA URL buttons — plain text fallback 
export async function sendCTAButtons(ctx, { body, footer, links }) {
  const { sock, jid, msg } = ctx
  if (!links?.length) throw new Error('sendCTAButtons: need at least 1 link')
  const lines = [body || '']
  links.forEach(l => lines.push(`🔗 *${l.label}*: ${l.url}`))
  if (footer) lines.push(`\n_${footer}_`)
  return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg })
}

//  Core: list / single_select 
// sections: [{ title, rows: [{ id, title, desc }] }]
export async function sendList(ctx, { body, footer, buttonLabel, sections }) {
  const { sock, jid, msg } = ctx
  if (!sections?.length) throw new Error('sendList: need at least 1 section')

  const listSections = sections.map(s => ({
    title: s.title || '',
    rows:  (s.rows || []).map(r => ({
      title:       r.title || '',
      description: r.desc  || '',
      id:          r.id    || '',
    })),
  }))

  return _sendInteractive(sock, jid, {
    body,
    footer,
    buttons: [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title:    buttonLabel || 'Select',
          sections: listSections,
        }),
      },
    ],
  }, { quoted: msg })
}

//  Core: plain text fallback 
export async function sendCTA(ctx, { body, footer, label, url }) {
  const { sock, jid, msg } = ctx
  const text = [body, footer && `_${footer}_`, url ? `🔗 ${label || 'Open'}: ${url}` : '']
    .filter(Boolean).join('\n')
  return sock.sendMessage(jid, { text }, { quoted: msg })
}


// 
//   CONVENIENCE WRAPPERS
// 

export async function sendCombatButtons(ctx, { body, footer, image, extra = [] }) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body, footer, image,
    buttons: [
      { id: `${p}attack`, label: '⚔️ Attack' },
      { id: `${p}defend`, label: '🛡️ Defend' },
      { id: `${p}flee`,   label: '💨 Flee'   },
      ...extra,
    ],
  })
}

export async function sendDungeonButtons(ctx, { body, footer, image, showSkill = true }) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body, footer, image,
    buttons: showSkill
      ? [
          { id: `${p}attack`, label: '⚔️ Attack' },
          { id: `${p}skill`,  label: '✨ Skill'   },
          { id: `${p}defend`, label: '🛡️ Defend'  },
        ]
      : [
          { id: `${p}attack`, label: '⚔️ Attack' },
          { id: `${p}defend`, label: '🛡️ Defend'  },
          { id: `${p}flee`,   label: '💨 Flee'    },
        ],
  })
}

export async function sendBossButtons(ctx, { body, footer, image }) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body, footer, image,
    buttons: [
      { id: `${p}bossattack`, label: '⚔️ Attack' },
      { id: `${p}bossskill`,  label: '✨ Skill'   },
      { id: `${p}bossdefend`, label: '🛡️ Defend'  },
    ],
  })
}

export async function sendVictoryButtons(ctx, { wasInDungeon = false } = {}) {
  const p = ctx.prefix || '!'
  if (wasInDungeon) {
    return sendButtons(ctx, {
      body:    '\nWhat do you do next?',
      footer:  'Astral of the Sun ⚔️',
      buttons: [
        { id: `${p}rift`,      label: '🗺️ Continue Rift' },
        { id: `${p}profile`,   label: '📋 View Profile'  },
        { id: `${p}inventory`, label: '🎒 Inventory'     },
      ],
    })
  }
  return sendButtons(ctx, {
    body:    '\nWhat do you do next?',
    footer:  'Astral of the Sun ⚔️',
    buttons: [
      { id: `${p}prowl`,     label: '🗡️ Prowl Again'  },
      { id: `${p}profile`,   label: '📋 View Profile'  },
      { id: `${p}inventory`, label: '🎒 Inventory'     },
    ],
  })
}

export async function sendDeathButtons(ctx, { wasInDungeon = false } = {}) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body:    '\nRise again?',
    footer:  'Astral of the Sun ⚔️',
    buttons: [
      { id: `${p}${wasInDungeon ? 'rift' : 'prowl'}`, label: wasInDungeon ? '🗺️ Re-Enter Rift' : '🗡️ Fight Again' },
      { id: `${p}profile`, label: '📋 Check Stats'  },
      { id: `${p}daily`,   label: '📅 Daily Reward' },
    ],
  })
}

export async function sendProfileButtons(ctx, { body, footer, image }) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body, footer, image,
    buttons: [
      { id: `${p}inventory`, label: '🎒 Inventory'  },
      { id: `${p}skills`,    label: '✨ Skills'      },
      { id: `${p}equipment`, label: '🛡️ Equipment'  },
    ],
  })
}

export async function sendShopButtons(ctx, { body, footer, shopId }) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body, footer,
    buttons: [
      { id: `${p}shop ${shopId}`, label: '🛒 Browse Items' },
      { id: `${p}inventory`,      label: '🎒 My Inventory'  },
      { id: `${p}profile`,        label: '📋 My Profile'    },
    ],
  })
}

export async function sendDailyButtons(ctx, { body, footer }) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body, footer,
    buttons: [
      { id: `${p}daily`,   label: '📅 Daily Reward' },
      { id: `${p}quests`,  label: '📜 Daily Quests'  },
      { id: `${p}prowl`,   label: '🗡️ Go Prowl'      },
    ],
  })
}

export async function sendQuestButtons(ctx, { body, footer }) {
  const p = ctx.prefix || '!'
  return sendButtons(ctx, {
    body, footer,
    buttons: [
      { id: `${p}quest list`,     label: '📜 View Quests' },
      { id: `${p}quest complete`, label: '✅ Turn In'      },
      { id: `${p}profile`,        label: '📋 My Profile'  },
    ],
  })
}

export async function sendGroupLinks(ctx, { body, footer, links }) {
  return sendCTAButtons(ctx, { body, footer, links })
}

export async function sendMainMenuList(ctx, { body, footer }) {
  const p = ctx.prefix || '!'
  return sendList(ctx, {
    body, footer,
    buttonLabel: '📖 Open Menu',
    sections: [
      {
        title: '⚔️ Combat',
        rows: [
          { id: `${p}prowl`, title: '🗡️ Prowl',      desc: 'Hunt monsters in your region' },
          { id: `${p}rift`,  title: '🌀 Enter Rift',  desc: 'Dive into the dungeon'        },
          { id: `${p}pvp`,   title: '🤺 PVP',         desc: 'Challenge another player'     },
        ],
      },
      {
        title: '🧳 Character',
        rows: [
          { id: `${p}profile`,   title: '📋 Profile',   desc: 'View your character stats' },
          { id: `${p}inventory`, title: '🎒 Inventory', desc: 'Manage your items'         },
          { id: `${p}skills`,    title: '✨ Skills',    desc: 'View & upgrade skills'      },
        ],
      },
      {
        title: '💰 Economy',
        rows: [
          { id: `${p}shop`,  title: '🛒 Shop',          desc: 'Browse available items'     },
          { id: `${p}vault`, title: '🏦 Vault',         desc: 'Deposit or withdraw Solars' },
          { id: `${p}daily`, title: '📅 Daily Rewards', desc: 'Claim your daily bonus'     },
        ],
      },
    ],
  })
}

export async function sendHelpList(ctx, { body, footer }) {
  const p = ctx.prefix || '!'
  return sendList(ctx, {
    body:        body   || '📖 *What do you need help with?*',
    footer:      footer || 'Select a topic',
    buttonLabel: '📖 Help Topics',
    sections: [
      {
        title: '⚔️ Gameplay',
        rows: [
          { id: `${p}help character`, title: '👤 Character',  desc: 'Profile, stats & evolution' },
          { id: `${p}help combat`,    title: '⚔️ Combat',     desc: 'Fighting, rift & ranked'    },
          { id: `${p}help adventure`, title: '🌍 Adventure',  desc: 'Roam, prowl & map'          },
          { id: `${p}help boss`,      title: '👹 Boss Raids', desc: 'World boss mechanics'        },
          { id: `${p}help quests`,    title: '📜 Quests',     desc: 'Daily quests & missions'     },
        ],
      },
      {
        title: '💰 Economy',
        rows: [
          { id: `${p}help economy`, title: '💰 Economy', desc: 'Vault, shop & jobs'      },
          { id: `${p}help premium`, title: '👑 Premium', desc: 'Premium perks & benefits' },
          { id: `${p}help topup`,   title: '💎 Top Up',  desc: 'Buy Astra & Solars'       },
        ],
      },
      {
        title: '🎴 More',
        rows: [
          { id: `${p}help skills`, title: '✨ Skills', desc: 'Skill points & passives' },
          { id: `${p}help cards`,  title: '🃏 Cards',  desc: 'Anime card collection'   },
          { id: `${p}help social`, title: '👥 Social', desc: 'Party, faction & trade'   },
        ],
      },
    ],
  })
}

export async function sendLeaderboardList(ctx, { body, footer }) {
  const p = ctx.prefix || '!'
  return sendList(ctx, {
    body:        body   || '🏆 *Choose a leaderboard to view:*',
    footer:      footer || 'Tap "Select" to open',
    buttonLabel: '🏆 Choose Board',
    sections: [{
      title: '🏆 Leaderboard Categories',
      rows: [
        { id: `${p}leaderboard`,       title: '⚡ Power Rank',   desc: 'Overall strength & prestige' },
        { id: `${p}leaderboard Solars`,  title: '💰 Solars Rank',  desc: 'Wealthiest adventurers'      },
        { id: `${p}leaderboard pvp`,   title: '🤺 PVP Rank',     desc: 'Top duelists'                },
        { id: `${p}leaderboard kld`,   title: '💀 Kill Rank',    desc: 'Most monsters slain'         },
        { id: `${p}leaderboard cards`, title: '🃏 Card Rank',    desc: 'Best card collectors'        },
        { id: `${p}weeklytop`,         title: '📅 Weekly Top',   desc: "This week's leaders"         },
      ],
    }],
  })
}

export async function sendRegionList(ctx, { body, footer, regions }) {
  const p = ctx.prefix || '!'
  const chunkSize = 5
  const sections = []
  for (let i = 0; i < regions.length; i += chunkSize) {
    const chunk = regions.slice(i, i + chunkSize)
    sections.push({
      title: i === 0 ? '🗺️ Available Regions' : '🗺️ More Regions',
      rows: chunk.map(r => ({
        id:    `${p}travel ${r.id}`,
        title: `${r.emoji || '🌍'} ${r.name}`,
        desc:  r.desc || `Lv ${r.minLevel || '?'}+`,
      })),
    })
  }
  return sendList(ctx, {
    body:        body   || '🗺️ *Select a region to travel to:*',
    footer:      footer || 'Tap "Select" to choose',
    buttonLabel: '🗺️ Choose Region',
    sections,
  })
}

export async function sendShopList(ctx, { body, footer, shops }) {
  const p = ctx.prefix || '!'
  return sendList(ctx, {
    body:        body   || '🛒 *Available Shops:*',
    footer:      footer || 'Select a shop to browse',
    buttonLabel: '🛒 Choose Shop',
    sections: [{
      title: '🏪 Shops',
      rows: shops.map(s => ({
        id:    `${p}shop ${s.id || s.name.toLowerCase().replace(/\s+/g, '_')}`,
        title: `${s.emoji || '🛒'} ${s.name}`,
        desc:  `${s.items?.length || 0} items available`,
      })),
    }],
  })
}

export async function sendInventoryCategoryList(ctx, { body, footer, categories }) {
  const p = ctx.prefix || '!'
  return sendList(ctx, {
    body:        body   || '🎒 *Select a category to view:*',
    footer:      footer || 'Tap to filter your inventory',
    buttonLabel: '🎒 Pick Category',
    sections: [{
      title: '📦 Categories',
      rows: categories.map(c => ({
        id:    `${p}inventory ${c.id}`,
        title: `${c.emoji} ${c.label}`,
        desc:  `${c.count} item${c.count !== 1 ? 's' : ''}`,
      })),
    }],
  })
}

export async function sendPartyList(ctx, { body, footer, options }) {
  const p = ctx.prefix || '!'
  const rows = options || [
    { id: `${p}party create`, title: '⚔️ Create Party',  desc: 'Start a new party'         },
    { id: `${p}party info`,   title: '📋 Party Info',    desc: "View your party's status"  },
    { id: `${p}party leave`,  title: '🚪 Leave Party',   desc: 'Leave your current party'  },
    { id: `${p}partydungeon`, title: '🌀 Party Dungeon', desc: 'Enter dungeon together'     },
  ]
  return sendList(ctx, {
    body:        body   || '⚔️ *Party Options:*',
    footer:      footer || 'Select an action',
    buttonLabel: '⚔️ Party Menu',
    sections: [{ title: 'Party Actions', rows }],
  })
}


// 
//   SAFE WRAPPERS
// 

export async function trySendButtons(ctx, opts) {
  try {
    return await sendButtons(ctx, opts)
  } catch (e) {
    const lines = [opts.body || '']
    opts.buttons?.forEach((b, i) => lines.push(`${i + 1}. ${b.label}  →  _${b.id}_`))
    if (opts.footer) lines.push(`\n_${opts.footer}_`)
    const reply = ctx.replyText || ctx.reply
    return reply(lines.join('\n'))
  }
}

export async function trySendList(ctx, opts) {
  try {
    return await sendList(ctx, opts)
  } catch (e) {
    const lines = [opts.body || '']
    for (const s of (opts.sections || [])) {
      if (s.title) lines.push('\n*' + s.title + '*')
      for (const r of (s.rows || [])) {
        lines.push('• ' + r.title + (r.desc ? ' — ' + r.desc : ''))
        lines.push('  _' + r.id + '_')
      }
    }
    if (opts.footer) lines.push(`\n_${opts.footer}_`)
    const reply = ctx.replyText || ctx.reply
    return reply(lines.join('\n'))
  }
}

export async function trySendVictoryButtons(ctx, opts = {}) {
  try { return await sendVictoryButtons(ctx, opts) } catch { /* silent */ }
}

export async function trySendDeathButtons(ctx, opts = {}) {
  try { return await sendDeathButtons(ctx, opts) } catch { /* silent */ }
}


// 
//   INBOUND: BUTTON-TAP PARSING
// 

/**
 * Extracts the tapped button's id from an incoming message's (already
 * unwrapped, e.g. via normalizeMessageContent) content object. Returns
 * null for any message that isn't a button tap, or if the payload is
 * malformed — never throws, so it's safe to call unconditionally on every
 * inbound message the way handler.js reads `body`.
 *
 * Checks three possible reply shapes, in order:
 *   1. interactiveResponseMessage.nativeFlowResponseMessage.paramsJson —
 *      the shape sendButtons() above actually builds (nativeFlowMessage /
 *      "quick_reply"). This is the primary, expected path.
 *   2. buttonsResponseMessage.selectedButtonId — older/simpler WhatsApp
 *      client builds sometimes echo a tap on a relayMessage-sent
 *      interactiveMessage back as this legacy type instead of the native-
 *      flow response, depending on the tapping device's WhatsApp version.
 *   3. listResponseMessage.singleSelectReply.selectedRowId — same idea,
 *      covers a list-style reply if this ever gets reused for list
 *      messages instead of quick-reply buttons.
 *   4. templateButtonReplyMessage.selectedId — the third legacy echo shape.
 *      Some clients answer a relayMessage-sent interactiveMessage with this
 *      instead of either of the two above, and until it was checked here the
 *      tap produced an empty `body` in handler.js, so nothing downstream ran
 *      at all (in a DM that surfaced as the DM lock answering a Story Mode
 *      option with "DMs are closed").
 *   5. The tapped button's display text, when the id is absent but the label
 *      came back (nativeFlowResponseMessage's display_text, or either legacy
 *      shape's selectedDisplayText). Callers that only understand ids can
 *      still ignore it; callers that match on labels too (see
 *      plugins/story.js's resolveChoiceOption) resolve it correctly, which
 *      beats returning null and losing the tap entirely.
 * Falling through all of them covers every shape a tap on a hand-built
 * interactiveMessage has been observed to come back as, without needing to
 * know in advance which one a given client will use — a previously-silent
 * "bot reacted but never ran the command" symptom traced to case 1 alone
 * not matching what some clients actually send back.
 */
export function extractButtonReplyId(content) {
  const paramsJson = content?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
  let displayText = null
  if (paramsJson) {
    try {
      const parsed = JSON.parse(paramsJson)
      if (parsed?.id != null) return String(parsed.id)
      if (parsed?.display_text != null) displayText = String(parsed.display_text)
    } catch {
      // fall through to the legacy shapes below
    }
  }

  const legacyButtonId = content?.buttonsResponseMessage?.selectedButtonId
  if (legacyButtonId != null) return String(legacyButtonId)

  const listRowId = content?.listResponseMessage?.singleSelectReply?.selectedRowId
  if (listRowId != null) return String(listRowId)

  const templateId = content?.templateButtonReplyMessage?.selectedId
  if (templateId != null) return String(templateId)

  const label = displayText
    ?? content?.buttonsResponseMessage?.selectedDisplayText
    ?? content?.templateButtonReplyMessage?.selectedDisplayText
    ?? null
  if (label != null && String(label).trim()) return String(label)

  return null
}
