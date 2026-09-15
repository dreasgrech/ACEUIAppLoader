"""ws_echo.py - a loopback WebSocket listener, to settle whether the game's HUD can
actually open a socket.

The capability probe's "WebSocket connect (loopback)" check opens `ws://127.0.0.1:47800`.
Against a closed port it reported no `open`, no `close` and no `error` at all, which is
ambiguous: either Cohtml never really connects, or it connects and never surfaces the
failure. This server answers that. Run it, then hit "Re-run" in the probe:

    python tools/ws_echo.py

    probe row                                    verdict
    ---------------------------------------------------------------------------------
    "connected -- something is listening"  (yes)  WebSocket works. Sockets are open.
    still "no open, close or error"       (warn)  and NOTHING logged here: the page
                                                  never even made a TCP connection.
    still warn, but "TCP connect" logged here     TCP works, the WebSocket handshake or
                                                  its events do not.

That middle column is the point: this script logs the raw TCP accept *before* the
WebSocket handshake, so a connection that arrives but never completes still shows up.

Stdlib only (no `websockets` package): the RFC 6455 handshake is a SHA-1 of the client
key plus the protocol GUID, and frames are small enough to parse by hand. It binds
127.0.0.1 only -- nothing is exposed off this machine.

    python tools/ws_echo.py --port 47800 --timeout 120 --once

--once exits after the first connection closes; --timeout N exits after N idle seconds
(0 = run until Ctrl+C). Both exist so this can never be left running by accident.
"""
import argparse
import base64
import hashlib
import socket
import struct
import sys
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_TEXT = 0x1
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


def stamp():
    return time.strftime("%H:%M:%S")


def say(message):
    sys.stdout.write("[%s] %s\n" % (stamp(), message))
    sys.stdout.flush()


def read_until_headers(conn):
    """Read the HTTP request head. Returns the raw bytes, or b"" if the peer went away."""
    data = b""

    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)

        if not chunk:
            return data

        data += chunk

        if len(data) > 65536:
            break

    return data


def parse_headers(raw):
    headers = {}
    lines = raw.split(b"\r\n")

    for line in lines[1:]:
        if b":" not in line:
            continue

        name, _, value = line.partition(b":")
        headers[name.strip().lower().decode("latin-1")] = value.strip().decode("latin-1")

    request_line = lines[0].decode("latin-1") if lines else ""

    return request_line, headers


def accept_key(client_key):
    digest = hashlib.sha1((client_key + GUID).encode("latin-1")).digest()

    return base64.b64encode(digest).decode("latin-1")


def send_frame(conn, payload, opcode=OP_TEXT):
    """Server -> client frames are never masked."""
    body = payload.encode("utf-8") if isinstance(payload, str) else payload
    header = bytearray()
    header.append(0x80 | opcode)
    length = len(body)

    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += struct.pack(">H", length)
    else:
        header.append(127)
        header += struct.pack(">Q", length)

    conn.sendall(bytes(header) + body)


def recv_exact(conn, count):
    data = b""

    while len(data) < count:
        chunk = conn.recv(count - len(data))

        if not chunk:
            return None

        data += chunk

    return data


def read_frame(conn):
    """Returns (opcode, payload bytes) or (None, None) when the peer closed."""
    head = recv_exact(conn, 2)

    if not head:
        return None, None

    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F

    if length == 126:
        extended = recv_exact(conn, 2)

        if not extended:
            return None, None

        length = struct.unpack(">H", extended)[0]
    elif length == 127:
        extended = recv_exact(conn, 8)

        if not extended:
            return None, None

        length = struct.unpack(">Q", extended)[0]

    mask = recv_exact(conn, 4) if masked else None

    if masked and mask is None:
        return None, None

    payload = recv_exact(conn, length) if length else b""

    if payload is None:
        return None, None

    if masked:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))

    return opcode, payload


def serve_connection(conn, addr):
    """Handshake, then echo whatever arrives. Returns True if the handshake succeeded."""
    say("TCP connect from %s:%s" % addr)

    raw = read_until_headers(conn)

    if not raw:
        say("  ...peer closed before sending anything (TCP only, no HTTP request)")

        return False

    request_line, headers = parse_headers(raw)
    say("  request: %s" % request_line)

    key = headers.get("sec-websocket-key")

    if not key:
        # Plain HTTP: this is the XHR probe ("XHR to a network host"), not the socket
        # one. Answer 200 so the page sees a clean load rather than a dropped
        # connection -- that turns its row into a definite yes instead of an error.
        say("  PLAIN HTTP request (no Sec-WebSocket-Key) -- this is the XHR probe")
        say("  ==> a network XHR DID leave the page; answering 200")

        body = b"ws_echo.py: plain HTTP request seen\n"
        conn.sendall(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: text/plain\r\n"
            b"Access-Control-Allow-Origin: *\r\n"
            b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n"
            b"Connection: close\r\n\r\n" + body
        )

        return False

    say("  upgrade seen: origin=%s version=%s"
        % (headers.get("origin", "-"), headers.get("sec-websocket-version", "-")))

    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n" % accept_key(key)
    )
    conn.sendall(response.encode("latin-1"))
    say("  HANDSHAKE OK -- the page's onopen should have fired")

    send_frame(conn, "hello from ws_echo.py")

    while True:
        opcode, payload = read_frame(conn)

        if opcode is None:
            say("  peer closed the connection")
            break

        if opcode == OP_CLOSE:
            say("  close frame received")

            try:
                send_frame(conn, b"", OP_CLOSE)
            except socket.error:
                pass

            break

        if opcode == OP_PING:
            send_frame(conn, payload, OP_PONG)
            continue

        if opcode == OP_TEXT:
            text = payload.decode("utf-8", "replace")
            say("  message: %s" % (text[:200]))
            send_frame(conn, "echo: " + text)

    return True


def main():
    parser = argparse.ArgumentParser(description="Loopback WebSocket echo server for the ACE UI capability probe.")
    parser.add_argument("--port", type=int, default=47800, help="port to listen on (default 47800)")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind (default 127.0.0.1, loopback only)")
    parser.add_argument("--once", action="store_true", help="exit after the first connection closes")
    parser.add_argument("--timeout", type=int, default=0, help="exit after N seconds with no connection (0 = forever)")
    args = parser.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    # On Windows SO_REUSEADDR lets a second process HIJACK a port another process is
    # already listening on: both bind, and connections land on either one. That once
    # cost us a confusing test run. SO_EXCLUSIVEADDRUSE makes the second bind fail
    # loudly instead, which is what we want -- an already-running instance is a bug.
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        server.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    try:
        server.bind((args.host, args.port))
    except socket.error as err:
        say("cannot bind %s:%d -- %s" % (args.host, args.port, err))
        say("is another ws_echo.py still running? close it (Ctrl+C) and retry.")

        return 1

    server.listen(4)

    if args.timeout:
        server.settimeout(args.timeout)

    say("listening on ws://%s:%d  (Ctrl+C to stop)" % (args.host, args.port))
    say("now hit Re-run in the ACE UI Capabilities Probe")

    handshakes = 0

    try:
        while True:
            try:
                conn, addr = server.accept()
            except socket.timeout:
                say("no connection within %ds -- giving up" % args.timeout)
                break

            conn.settimeout(30)

            try:
                if serve_connection(conn, addr):
                    handshakes += 1
            except socket.timeout:
                say("  ...timed out waiting for the peer")
            except socket.error as err:
                say("  socket error: %s" % err)
            finally:
                try:
                    conn.close()
                except socket.error:
                    pass

            if args.once:
                break
    except KeyboardInterrupt:
        say("stopped")
    finally:
        server.close()

    say("done -- %d completed WebSocket handshake(s)" % handshakes)

    return 0


if __name__ == "__main__":
    sys.exit(main())
