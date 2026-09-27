# Forwards TCP from this node's FIPS address to a service on loopback,
# inside node B's namespace: the mock mint (127.0.0.1:3338, the default) and
# the reference TollGate only listen on loopback, while mesh peers reach
# node B at its fips0 address.
#
#   python3 proxy.py <fips0 address> <port> [<loopback port>]
import asyncio
import sys

LISTEN_HOST, LISTEN_PORT = sys.argv[1], int(sys.argv[2])
TARGET_HOST = '127.0.0.1'
TARGET_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 3338


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()


async def handle(client_reader, client_writer):
    target_reader, target_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
    await asyncio.gather(pipe(client_reader, target_writer), pipe(target_reader, client_writer))


async def main():
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    print(f'proxy [{LISTEN_HOST}]:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}', flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
