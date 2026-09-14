import {describe, expect, it} from 'vitest'
import vm from 'node:vm'
import {
  MigrationStopped,
  parseMigrationJournal,
  planMigration,
  runMigration
} from './migration'
import type {
  MigrationCard,
  MigrationJournal,
  MigrationOps,
  OldWallet
} from './migration'

const DESTINATION = '02' + 'ab'.repeat(32)
const card = (n: number): MigrationCard => ({
  secret: `["P2PK",{"nonce":"${n}"}]`,
  binding: n.toString(16).padStart(64, 'b'),
  asset_id: `600B-E1-00${n}`
})

/**
 * Two wallets and a mint, reduced to what a move can observe. A token here is
 * `cashuB` and the secret it carries; a fault can be set to strike once.
 */
const world = (cards: MigrationCard[]) => {
  const old: {cards: MigrationCard[]} & Required<OldWallet> = {
    cards: [...cards],
    pending: null,
    outgoing: []
  }
  const account = {cards: [] as MigrationCard[], imported: new Set<string>()}
  const saved: MigrationJournal[] = []
  const calls: string[] = []
  const faults: {
    tradeLost?: string
    tradeRefused?: string
    saveAfterTrade?: boolean
    importUnseen?: boolean
    newCardsDown?: boolean
    leak?: string
  } = {}
  const registry = new Map(cards.map(c => [c.secret, c]))
  const tokenFor = (secret: string) => `cashuB${secret}`

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
    oldWallet: async () => ({pending: old.pending, outgoing: old.outgoing}),
    oldCards: async () => {
      calls.push('oldCards')
      return [...old.cards]
    },
    trade: async (secret, destination) => {
      calls.push(`trade:${secret}`)
      expect(destination).toBe(DESTINATION)
      if (faults.tradeRefused === secret) {
        faults.tradeRefused = undefined
        throw new Error(`disconnected ${faults.leak ?? ''}`)
      }
      old.cards = old.cards.filter(c => c.secret !== secret)
      if (faults.tradeLost === secret) {
        faults.tradeLost = undefined
        old.pending = {type: 'trade', input_secret: secret}
        throw new Error(`answer lost for ${tokenFor(secret)}`)
      }
      old.outgoing = [{token: tokenFor(secret)}, ...old.outgoing]
      return tokenFor(secret)
    },
    finishTrade: async () => {
      calls.push('finishTrade')
      const secret = old.pending!.input_secret!
      old.pending = null
      old.outgoing = [{token: tokenFor(secret)}, ...old.outgoing]
      return tokenFor(secret)
    },
    cardOf: token => registry.get(token.replace(/^cashuB/, '')) ?? null,
    importCard: async token => {
      calls.push(`import:${token}`)
      if (account.imported.has(token))
        throw new Error('token is already in this wallet')
      account.imported.add(token)
      if (faults.importUnseen) return
      const moved = registry.get(token.replace(/^cashuB/, ''))!
      /* Re-issued to the account's own outputs: a new secret, the same card. */
      account.cards.push({...moved, secret: `reissued:${moved.secret}`})
    },
    newCards: async () => {
      calls.push('newCards')
      if (faults.newCardsDown) {
        faults.newCardsDown = false
        throw new Error('mint unreachable')
      }
      return [...account.cards]
    }
  }
  return {old, account, saved, calls, faults, ops}
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
      if (call.startsWith('import:')) {
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
    const trades = w.calls.filter(call => call.startsWith('trade:')).length
    expect(await runMigration(lastSaved(w), w.ops)).toEqual({
      moved: 2,
      gone: 0
    })
    expect(w.calls).toContain('finishTrade')
    /* The first card was not traded a second time. */
    expect(
      w.calls.filter(call => call === `trade:${card(1).secret}`)
    ).toHaveLength(1)
    expect(w.calls.filter(call => call.startsWith('trade:')).length).toBe(
      trades + 1
    )
  })

  it('resumes from the sent transfer when the journal missed the answer', async () => {
    const w = world([card(1)])
    w.faults.saveAfterTrade = true
    await expect(
      runMigration(planMigration(DESTINATION, w.old.cards), w.ops)
    ).rejects.toThrow(MigrationStopped)
    const journal = lastSaved(w)
    expect(journal.steps[0]).toMatchObject({
      state: 'trading',
      outgoingBefore: 0
    })
    expect(w.old.outgoing).toHaveLength(1)

    expect(await runMigration(journal, w.ops)).toEqual({moved: 1, gone: 0})
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

  it('marks a card gone only when nothing says it was traded here', async () => {
    const w = world([card(1), card(2)])
    const journal = planMigration(DESTINATION, w.old.cards)
    journal.steps[0] = {
      ...journal.steps[0],
      state: 'trading',
      outgoingBefore: 0
    }
    /* Spent elsewhere, from another copy of the old wallet. */
    w.old.cards = [card(2)]
    expect(await runMigration(journal, w.ops)).toEqual({moved: 1, gone: 1})
    expect(lastSaved(w).steps.map(s => s.state)).toEqual(['gone', 'importing'])
  })

  it('counts an import that landed before the move stopped', async () => {
    const w = world([card(1)])
    const journal = planMigration(DESTINATION, w.old.cards)
    w.faults.newCardsDown = true
    /* The baseline read fails before the first import. */
    await expect(runMigration(journal, w.ops)).rejects.toThrow(MigrationStopped)
    const resumed = lastSaved(w)
    expect(resumed.steps[0].state).toBe('traded')
    expect(await runMigration(resumed, w.ops)).toEqual({moved: 1, gone: 0})
    /* And once more from `importing`, as after a crash right after import. */
    const again = lastSaved(w)
    expect(again.steps[0].state).toBe('importing')
    expect(await runMigration(again, w.ops)).toEqual({moved: 1, gone: 0})
  })

  it('recognises the library refusal when it comes from another realm', async () => {
    const w = world([card(1)])
    await runMigration(planMigration(DESTINATION, w.old.cards), w.ops)
    const again = lastSaved(w)
    expect(again.steps[0].state).toBe('importing')
    /* The card library runs in its own realm in tests, and its errors are
       not instances of this realm's Error. */
    const foreign = vm.runInContext(
      'new Error("token is already in this wallet")',
      vm.createContext({})
    )
    expect(foreign instanceof Error).toBe(false)
    const importCard = w.ops.importCard
    w.ops.importCard = async () => {
      throw foreign
    }
    expect(await runMigration(again, w.ops)).toEqual({moved: 1, gone: 0})
    w.ops.importCard = importCard
  })

  it('refuses to finish while a card is not confirmed under the account', async () => {
    const w = world([card(1), card(2)])
    w.faults.importUnseen = true
    const outcome = await runMigration(
      planMigration(DESTINATION, w.old.cards),
      w.ops
    ).catch(error => error)
    expect(outcome).toBeInstanceOf(MigrationStopped)
    expect(outcome.reason).toBe('unconfirmed')
    expect(lastSaved(w).steps.map(s => s.state)).toEqual([
      'importing',
      'importing'
    ])
    /* The cards turn up under the account key; the move then finishes. */
    w.account.cards.push(
      {...card(1), secret: 'reissued-later-1'},
      {...card(2), secret: 'reissued-later-2'}
    )
    expect(await runMigration(lastSaved(w), w.ops)).toEqual({
      moved: 2,
      gone: 0
    })
  })

  it('does not count a card the account already held as a moved one', async () => {
    const w = world([card(1)])
    w.account.cards.push({...card(1), secret: 'held-before-the-move'})
    w.faults.importUnseen = true
    await expect(
      runMigration(planMigration(DESTINATION, w.old.cards), w.ops)
    ).rejects.toThrow(/not yet confirmed/)
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
    const j = planMigration(DESTINATION, [card(1), card(2)])
    j.held = {[card(1).binding]: ['held']}
    j.steps[0] = {...j.steps[0], state: 'importing', token: 'cashuBx'}
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
      j => (j.steps[1].state = 'confirmed'),
      j => (j.steps[1].token = 'cashuBy'),
      j => delete j.steps[0].token,
      j => delete j.held,
      j => (j.steps[0].binding = 'x'.repeat(64)),
      j => (j.steps[1].outgoingBefore = -1),
      j => (j.held = {[card(1).binding]: [7]})
    ]
    for (const change of variants) {
      const j = journal()
      change(j)
      expect(() => parseMigrationJournal(j)).toThrow(MigrationStopped)
    }
  })
})
