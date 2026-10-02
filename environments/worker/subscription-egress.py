"""Authenticated CONNECT relay over Docker stdio; TLS remains end-to-end."""
import base64
import json
import socket
import struct
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_FRAME = 1024 * 1024
writer = threading.Lock()
peers = {}
peers_lock = threading.Lock()


def read_exact(length):
    data = bytearray()
    while len(data) < length:
        part = sys.stdin.buffer.read(length - len(data))
        if not part:
            raise EOFError()
        data.extend(part)
    return bytes(data)


def receive():
    length = struct.unpack('>I', read_exact(4))[0]
    if length < 1 or length > MAX_FRAME:
        raise ValueError('Invalid egress frame')
    return json.loads(read_exact(length))


def send(value):
    data = json.dumps(value, separators=(',', ':')).encode()
    with writer:
        sys.stdout.buffer.write(struct.pack('>I', len(data)) + data)
        sys.stdout.buffer.flush()


bootstrap = receive()
authorization = 'Basic ' + base64.b64encode(('missioncontrol:' + bootstrap['token']).encode()).decode()


class Peer:
    def __init__(self, connection):
        self.connection = connection
        self.opened = threading.Event()
        self.accepted = False
        self.write_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        if self.headers.get('Proxy-Authorization') != authorization:
            self.send_error(407)
            return
        try:
            host, port = self.path.split(':')
            if int(port) != 443:
                raise ValueError()
        except ValueError:
            self.send_error(403)
            return
        connection_id = uuid.uuid4().hex
        peer = Peer(self.connection)
        with peers_lock:
            if len(peers) >= bootstrap['maxConnections']:
                self.send_error(503)
                return
            peers[connection_id] = peer
        try:
            send({'kind': 'connect', 'id': connection_id, 'host': host, 'port': int(port)})
            if not peer.opened.wait(15) or not peer.accepted:
                self.send_error(403)
                return
            self.send_response(200, 'Connection established')
            self.end_headers()
            self.connection.settimeout(bootstrap['timeoutMs'] / 1000)
            while True:
                data = self.connection.recv(65536)
                if not data:
                    break
                send({'kind': 'data', 'id': connection_id, 'data': base64.b64encode(data).decode()})
        except (EOFError, OSError, ValueError):
            pass
        finally:
            with peers_lock:
                peers.pop(connection_id, None)
            send({'kind': 'close', 'id': connection_id})
            self.close_connection = True


def reader():
    try:
        while True:
            frame = receive()
            with peers_lock:
                peer = peers.get(frame['id'])
            if peer is None:
                continue
            if frame['kind'] == 'opened':
                peer.accepted = True
                peer.opened.set()
            elif frame['kind'] == 'error':
                peer.opened.set()
            elif frame['kind'] == 'data':
                with peer.write_lock:
                    peer.connection.sendall(base64.b64decode(frame['data'], validate=True))
            elif frame['kind'] == 'close':
                peer.connection.shutdown(socket.SHUT_RDWR)
    except (EOFError, OSError, ValueError, KeyError):
        with peers_lock:
            for peer in peers.values():
                peer.opened.set()
                try:
                    peer.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


threading.Thread(target=reader, daemon=True).start()
ThreadingHTTPServer(('0.0.0.0', 8081), Handler).serve_forever()
