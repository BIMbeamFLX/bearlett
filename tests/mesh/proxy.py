# Forwards TCP from this node's FIPS address (port 80) to the mock mint on
# 127.0.0.1:3338, inside node B's namespace: the mock only listens on
# loopback, while mesh peers reach node B at its fips0 address.
import asyncio
import sys

LISTEN_HOST, LISTEN_PORT = sys.argv[1], int(sys.argv[2])
TARGET_HOST, TARGET_PORT = '127.0.0.1', 3338


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
