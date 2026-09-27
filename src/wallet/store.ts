// Where the sealed vault and the sealed state live: a port, because the web
// app has localStorage and a Hangar napplet has the shell's storage domain.

export type Store = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export const VAULT_KEY = 'bearlett:vault:v1'
export const STATE_KEY = 'bearlett:state:v1'

export const localStore = (storage: Storage = localStorage): Store => ({
  async get(key) {
    return storage.getItem(key)
  },
  async set(key, value) {
    storage.setItem(key, value)
  },
  async remove(key) {
    storage.removeItem(key)
  }
})

/** In memory: previews and tests. */
export const memoryStore = (): Store => {
  const data = new Map<string, string>()
  return {
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async remove(key) {
      data.delete(key)
    }
  }
}
