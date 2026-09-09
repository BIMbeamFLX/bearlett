# Real mint / Lightning regtest

Official LNURLmint and Nutshell connect to separate LND nodes on an isolated
Bitcoin regtest network. Only test coins are used. Ports bind to localhost.
Fixed Bitcoin RPC credentials and Cashu seed are exclusively for regtest.

Prerequisites: Docker Compose, Node.js 24 and Bearlett npm dependencies.
On Windows the helper uses Docker inside WSL's `Ubuntu` distribution.

```sh
git clone https://github.com/lnurlcash/lnurl-mint.git work/lnurl-mint
docker compose -f tests/integration/compose.yaml build lnurl
node scripts/regtest.mjs
npm run test:regtest
```

On Windows, keep `wsl -d Ubuntu -- docker compose -f <absolute-WSL-path>/tests/integration/compose.yaml up`
running in a separate terminal. Otherwise Windows may stop idle WSL/Docker.
Rerun `node scripts/regtest.mjs` after restarting to load the Bitcoin wallet
and reconnect Lightning peers.

The helper mines blocks and opens a funded Alice/Bob channel. The test funds
LNURLcash from Bob, transfers LNURLcash→Cashu, funds Cashu from Alice and transfers
Cashu→LNURLcash. LNURLmint charges a flat sat; Nutshell charges input fees. The
second transfer deliberately loses its melt response, restores a backup into a
new wallet, and must finish with destination value and change without another melt.
Protocol operations and crypto use the actual implementations. The test host maps
only two fixed HTTPS identities to these local services.

Stop only this stack afterward:

```sh
docker compose -f tests/integration/compose.yaml stop
```

Named volumes remain for inspection. Unrelated projects are untouched. Images:
Bitcoin 29.0, LND 0.19.3-beta, Nutshell 0.20.3. Record the LNURLmint checkout SHA
when reporting a run; its external source checkout remains unmodified.
