/**
 * allcmds.js — every command a player can type.
 *
 * Owner tools are left out: the admin category, owner-only plugins, and
 * owner subcommands on mixed commands. .menu is still the ten sections.
 * This is the flat list.
 */
import { config } from '../config.js'
import { listPluginsFor } from '../lib/plugin-manager.js'
import { SECTIONS } from './menu.js'
import { buildCommandPages } from '../lib/command-list.js'

function prefixFor(platform) {
  return platform === 'telegram' ? config.telegramPrefix : config.prefix
}

export default {
  name: 'allcommands',
  aliases: ['cmdlist', 'allcmds', 'commandlist'],
  category: 'utility',
  cooldown: 5,
  requiresPlayer: false,
  description: 'Every player command, owner tools left out',
  subcommands: [
    { cmd: '<section>', desc: 'only that menu section' },
    { cmd: '<page>', desc: 'the next page of the full list' },
  ],

  async run(ctx) {
    const p = prefixFor(ctx.platform)
    const args = ctx.args ?? []
    let page = 1
    let sectionQuery = ''
    const words = []
    for (const arg of args) {
      if (/^\d+$/.test(arg)) page = parseInt(arg, 10)
      else words.push(arg)
    }
    sectionQuery = words.join(' ')

    const result = buildCommandPages(listPluginsFor(ctx.platform), {
      prefix: p,
      sections: SECTIONS,
      page,
      sectionQuery,
    })

    if (result.error === 'section') {
      return ctx.reply(
        `❌ No section *${sectionQuery}*.\n` +
        `Try: ${SECTIONS.map(s => `*${p}allcommands ${s.label}*` ).join('  ·  ')}`,
      )
    }

    const header =
      `📋 *${result.title}*\n` +
      `_${result.total} command${result.total === 1 ? '' : 's'} you can use. Owner tools are not listed._\n` +
      (result.pageCount > 1 ? `_Page ${result.page}/${result.pageCount}_\n` : '') +
      `\n`

    const footer = result.pageCount > 1
      ? `\n\n*${p}allcommands${sectionQuery ? ' ' + sectionQuery : ''} ${result.page + 1}* for the next page`
      : `\n\n_Sections: *${p}menu*_`

    return ctx.reply(header + result.text + (result.page < result.pageCount ? footer : `\n\n_Sections: *${p}menu*_`))
  },
}
