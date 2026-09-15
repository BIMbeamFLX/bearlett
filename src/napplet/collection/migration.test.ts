import {describe, expect, it} from 'vitest'
import {
  MigrationStopped,
  parseMigrationJournal,
  planMigration,
  runMigration
} from './migration'
import type {MigrationCard, MigrationJournal, MigrationOps} from './migration'

const DESTINATION = '02' + 'ab'.repeat(32)
const card = (n: number, copy = 0): MigrationCard => ({
  secret: `["P2PK",{"nonce":"${n}-${copy}"}]`,
  binding: n.toString(16).padStart(64, 'b'),
  asset_id: `600B-E1-00${n}`
})

/**
 * Two wallets and a mint, reduced to what a move can observe. A token is
 * `cashuB` followed by whom it is locked to and the proof it carries; a trade
 * gives the card a new proof, as the mint does. A fault strikes once.
 */
const world = (cards: MigrationCard[]) => {
  const old = {
    cards: [...cards],
    pending: null as {type: string; input_secret: string} | null,
    outgoing: [] as string[]
  }
  const account = {cards: [] as MigrationCard[]}
  const spent = new Set<string>()
  const saved: MigrationJournal[] = []
  const calls: string[] = []
  const faults: {
    tradeLost?: string
    tradeRefused?: string
    saveAfterTrade?: boolean
    statesDown?: boolean
    settleWaits?: number
    leak?: string
  } = {}
  const registry = new Map<string, MigrationCard>()
  const tokenOf = (to: 'account' | 'friend', moved: MigrationCard) => {
    registry.set(moved.secret, moved)
    return `cashuB:${to}:${moved.secret}`
  }
  const tradeOf = (secret: string, to: 'account' | 'friend') => {
    const traded = cards.find(c => c.secret === secret)!
    return tokenOf(to, {...traded, secret: `traded:${secret}`})
  }

  const ops: MigrationOps = {
    save: async journal => {
      calls.push(`save:${journal.steps.map(s => s.state).join(',')}`)
      if (
        faults.saveAfterTrade &&
        journal.steps.some(s => s.state === 'traded')
      ) {
        faults.saveAfterTrade = false
        throw new Error(`storage refused ${faults.leak ?? ''}`)
      }
      saved.push(structuredClone(journal))
    },
    oldWallet: async () => ({
      held: new Set(old.cards.map(c => c.secret)),
      pending: old.pending,
      outgoing: [...old.outgoing]
    }),
    states: async secrets => {
      calls.push(`states:${secrets.length}`)
      if (faults.statesDown) {
        faults.statesDown = false
        throw new Error('mint unreachable')
      }
      return new Map(
        secrets.map(secret => [secret, spent.has(secret) ? 'SPENT' : 'UNSPENT'])
      )
    },
    trade: async (secret, destination) => {
      calls.push(`trade:${secret}`)
      expect(destination).toBe(DESTINATION)
      if (faults.tradeRefused === secret) {
        faults.tradeRefused = undefined
        throw new Error(`disconnected ${faults.leak ?? ''}`)
      }
      spent.add(secret)
      old.cards = old.cards.filter(c => c.secret !== secret)
      if (faults.tradeLost === secret) {
        faults.tradeLost = undefined
        old.pending = {type: 'trade', input_secret: secret}
        throw new Error(`answer lost for ${tradeOf(secret, 'account')}`)
      }
      const token = tradeOf(secret, 'account')
      old.outgoing = [token, ...old.outgoing]
      return token
    },
    finishTrade: async () => {
      calls.push('finishTrade')
      const token = tradeOf(old.pending!.input_secret, 'account')
      old.pending = null
      old.outgoing = [token, ...old.outgoing]
      return token
    },
    cardOf: token => {
      const [, to, secret] = token.split(/:(account|friend):/)
      const moved = registry.get(secret)
      return moved ? {...moved, toDestination: to === 'account'} : null
    },
    settle: async token => {
      calls.push(`settle:${token}`)
      const moved = ops.cardOf(token)!
      if (faults.settleWaits) {
        faults.settleWaits -= 1
        throw new MigrationStopped('unconfirmed')
      }
      /* Re-issued to the account's own outputs: the traded proof is spent. */
      if (!spent.has(moved.secret)) {
        spent.add(moved.secret)
        account.cards.push({...moved, secret: `own:${moved.secret}`})
      }
    }
  }
  /* A token of the old wallet's own: a handover, or a move it made earlier. */
  const sent = (to: 'account' | 'friend', which: MigrationCard) => {
    spent.add(which.secret)
    old.cards = old.cards.filter(c => c.secret !== which.secret)
    const token = tradeOf(which.secret, to)
    old.outgoing = [token, ...old.outgoing]
    return token
  }
  return {old, account, spent, saved, calls, faults, ops, sent}
}

const lastSaved = (w: ReturnType<typeof world>) =>
  structuredClone(w.saved[w.saved.length - 1])

describe('runMigration', () => {
  it('moves every card and confirms each under the account key', async () => {
    const w = world([card(1), card(2)])
    const progress: string[] = []
    const result = await runMigration(
      planMigration(DESTINATION, w.old.cards),
      w.ops,
      (done, total) => progress.push(`${done}/${total}`)
    )
    expect(result).toEqual({moved: 2, gone: 0})
    expect(w.old.cards).toEqual([])
    expect(w.account.cards.map(c => c.binding)).toEqual([
      card(1).binding,
      card(2).binding
    ])
    expect(progress).toEqual(['1/2', '2/2'])
    expect(lastSaved(w).steps.map(s => s.state)).toEqual([
      'confirmed',
      'confirmed'
    ])
  })

  it('journals each step before the mint is asked to do it', async () => {
    const w = world([card(1), card(2)])
    await runMigration(planMigration(DESTINATION, w.old.cards), w.ops)
    for (const [index, call] of w.calls.entries()) {
      if (call.startsWith('trade:')) {
        const which = call === `trade:${card(1).secret}` ? 0 : 1
        expect(w.calls[index - 1].split(':')[1].split(',')[which]).toBe(
          'trading'
        )
      }
      if (call.startsWith('settle:')) {
        const which = call.endsWith(card(1).secret) ? 0 : 1
        expect(w.calls[index - 1].split(':')[1].split(',')[which]).toBe(
          'importing'
        )
      }
    }
  })

  it('resumes a trade whose answer was lost from the pending trade', async () => {
    const w = world([card(1), card(2)])
    w.faults.tradeLost = card(1).secret
    const first = await runMigration(
      planMigration(DESTINATION, w.old.cards),
      w.ops
    ).catch(error => error)
    expect(first).toBeInstanceOf(MigrationStopped)
    expect(first.message).not.toContain('cashuB')
    expect(lastSaved(w).steps[0].state).toBe('trading')

    /* The window closed; the next open reads the journal back. */
    expect(await runMigration(lastSaved(w), w.ops)).toEqual({
      moved: 2,
      gone: 0
    })
    expect(w.calls).toContain('finishTrade')
    expect(
      w.calls.filter(call => call === `trade:${card(1).secret}`)
    ).toHaveLength(1)
  })

  it('finds the traded card by its lock when the journal missed the answer', async () => {
    const w = world([card(1), card(2), card(3)])
    w.faults.saveAfterTrade = true
    await expect(
      runMigration(planMigration(DESTINATION, w.old.cards), w.ops)
    ).rejects.toThrow(MigrationStopped)
    expect(lastSaved(w).steps[0].state).toBe('trading')
    expect(w.old.outgoing).toHaveLength(1)
    /* Before the move resumes, the list changes: a handover of the same card's
       binding and a move of another card land in front of the token. */
    w.sent('friend', card(3))
    w.old.outgoing = [`cashuB:friend:${card(1).secret}-copy`, ...w.old.outgoing]

    expect(await runMigration(lastSaved(w), w.ops)).toEqual({moved: 2, gone: 1})
    expect(
      w.calls.filter(call => call === `trade:${card(1).secret}`)
    ).toHaveLength(1)
    expect(lastSaved(w).steps.map(s => s.state)).toEqual([
      'confirmed',
      'confirmed',
      'gone'
    ])
  })

  it('never takes another copy of the same card, or another step’s token', async () => {
    const one = card(1, 1)
    const two = card(1, 2)
    const w = world([one, two])
    w.faults.saveAfterTrade = true
    await expect(
      runMigration(planMigration(DESTINATION, w.old.cards), w.ops)
    ).rejects.toThrow(MigrationStopped)
    const journal = lastSaved(w)
    expect(journal.steps.map(s => s.state)).toEqual(['trading', 'planned'])
    /* Both copies traded before the journal caught up. */
    const first = w.old.outgoing[0]
    const second = w.sent('account', two)
    journal.steps[1].state = 'trading'

    expect(await runMigration(journal, w.ops)).toEqual({moved: 2, gone: 0})
    const tokens = lastSaved(w).steps.map(step => step.token)
    expect(new Set(tokens)).toEqual(new Set([first, second]))
    expect(w.calls.filter(call => call.startsWith('trade:'))).toHaveLength(1)
  })

  it('trades again when the first attempt never reached the mint', async () => {
    const w = world([card(1)])
    w.faults.tradeRefused = card(1).secret
    await expect(
      runMigration(planMigration(DESTINATION, w.old.cards), w.ops)
    ).rejects.toThrow(MigrationStopped)
    expect(await runMigration(lastSaved(w), w.ops)).toEqual({
      moved: 1,
      gone: 0
    })
    expect(w.calls.filter(call => call.startsWith('trade:'))).toHaveLength(2)
  })

  it('gives a card up as gone only when it left the wallet another way', async () => {
    const w = world([card(1), card(2), card(3)])
    const journal = planMigration(DESTINATION, w.old.cards)
    journal.steps.forEach(step => (step.state = 'trading'))
    /* Card 1 was handed to a friend; card 2 was spent from another copy of
       this wallet and is still listed here; card 3 never left. */
    w.sent('friend', card(1))
    w.spent.add(card(2).secret)

    expect(await runMigration(journal, w.ops)).toEqual({moved: 1, gone: 2})
    expect(lastSaved(w).steps.map(s => s.state)).toEqual([
      'gone',
      'gone',
      'confirmed'
    ])
  })

  it('stops, and gives nothing up, while the mint cannot be asked', async () => {
    const w = world([card(1)])
    const journal = planMigration(DESTINATION, w.old.cards)
    journal.steps[0].state = 'trading'
    w.faults.statesDown = true
    const outcome = await runMigration(journal, w.ops).catch(error => error)
    expect(outcome).toBeInstanceOf(MigrationStopped)
    expect(outcome.reason).toBe('failed')
    expect(journal.steps[0].state).toBe('trading')
    expect(w.calls.filter(call => call.startsWith('trade:'))).toEqual([])
  })

  it('refuses a traded token that is not locked to the account', async () => {
    const w = world([card(1)])
    const trade = w.ops.trade
    w.ops.trade = async (secret, destination) => {
      await trade(secret, destination)
      return `cashuB:friend:traded:${secret}`
    }
    const outcome = await runMigration(
      planMigration(DESTINATION, w.old.cards),
      w.ops
    ).catch(error => error)
    expect(outcome.reason).toBe('damaged')
    expect(w.calls.some(call => call.startsWith('settle:'))).toBe(false)
  })

  it('confirms each step on its own, and stops while one is unconfirmed', async () => {
    const w = world([card(1), card(2)])
    const journal = planMigration(DESTINATION, w.old.cards)
    const outcome = await runMigration(journal, {
      ...w.ops,
      settle: async token => {
        if (token.endsWith(card(2).secret)) {
          w.calls.push(`settle:${token}`)
          throw new MigrationStopped('unconfirmed')
        }
        return w.ops.settle(token)
      }
    }).catch(error => error)
    expect(outcome).toBeInstanceOf(MigrationStopped)
    expect(outcome.reason).toBe('unconfirmed')
    expect(lastSaved(w).steps.map(s => s.state)).toEqual([
      'confirmed',
      'importing'
    ])

    /* The account's re-issue goes through later; the move then finishes. */
    expect(await runMigration(lastSaved(w), w.ops)).toEqual({
      moved: 2,
      gone: 0
    })
    expect(w.calls.filter(call => call.endsWith(card(1).secret))).toHaveLength(
      2
    )
  })

  it('takes in a move token that no step knows about', async () => {
    const w = world([card(1), card(2)])
    const journal = planMigration(DESTINATION, [card(1)])
    w.sent('account', card(2))
    expect(await runMigration(journal, w.ops)).toEqual({moved: 2, gone: 0})
    expect(w.account.cards.map(c => c.binding)).toEqual([
      card(1).binding,
      card(2).binding
    ])
    expect(lastSaved(w).steps).toHaveLength(2)
  })

  it('leaves a handover to anyone else alone', async () => {
    const w = world([card(1), card(2)])
    const handover = w.sent('friend', card(2))
    expect(
      await runMigration(planMigration(DESTINATION, [card(1)]), w.ops)
    ).toEqual({moved: 1, gone: 0})
    expect(w.old.outgoing).toContain(handover)
    expect(
      w.calls.some(call => call.endsWith(`friend:${card(2).secret}`))
    ).toBe(false)
  })

  it('waits while the old wallet finishes a transfer of its own', async () => {
    const w = world([card(1)])
    w.old.pending = {type: 'trade', input_secret: 'a handover from before'}
    const outcome = await runMigration(
      planMigration(DESTINATION, w.old.cards),
      w.ops
    ).catch(error => error)
    expect(outcome.reason).toBe('busy')
    expect(w.calls.filter(call => call.startsWith('trade:'))).toEqual([])
    expect(w.saved).toEqual([])
  })

  it('never repeats a token, a secret or a message it was given', async () => {
    const w = world([card(1)])
    const token = 'cashuBo2FteBtodHRwczovL21pbnQudGVzdC9lMWF1Z3NlY3JldA'
    w.faults.leak = `${token} ${card(1).secret}`
    w.faults.tradeRefused = card(1).secret
    const outcome = await runMigration(
      planMigration(DESTINATION, w.old.cards),
      w.ops
    ).catch(error => error)
    const said = `${outcome.message} ${outcome.stack}`
    expect(said).not.toContain(token)
    expect(said).not.toContain('nonce')
    expect(said).not.toContain('disconnected')
  })
})

describe('parseMigrationJournal', () => {
  const journal = () => {
    const j = planMigration(DESTINATION, [card(1), card(2), card(3)])
    j.steps[0] = {...j.steps[0], state: 'importing', token: 'cashuBx'}
    j.steps[2] = {...j.steps[2], state: 'confirmed', token: 'cashuBz'}
    return JSON.parse(JSON.stringify(j))
  }

  it('reads back what a move writes', () => {
    expect(parseMigrationJournal(journal())).toEqual(journal())
  })

  it('refuses a journal that could send cards somewhere unintended', () => {
    const variants: Array<(j: any) => void> = [
      j => (j.destination = '04' + 'ab'.repeat(32)),
      j => (j.destination = DESTINATION.toUpperCase()),
      j => (j.kind = 'bearlett/other'),
      j => (j.v = 2),
      j => (j.steps = {}),
      j => (j.steps[1].state = 'confirmed'),
      j => (j.steps[1].state = 'held'),
      j => (j.steps[1].token = 'cashuBy'),
      j => delete j.steps[0].token,
      j => (j.steps[2].token = 'cashuBx'),
      j => (j.steps[0].binding = 'x'.repeat(64)),
      j => (j.steps[0].asset_id = ''),
      j => (j.steps[0].secret = 7)
    ]
    for (const change of variants) {
      const j = journal()
      change(j)
      expect(() => parseMigrationJournal(j)).toThrow(MigrationStopped)
    }
  })
})
