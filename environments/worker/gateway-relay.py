"""Inference-only relay over controller-owned Docker stdio. No TCP upstream."""
import base64
import json
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_FRAME = 6 * 1024 * 1024
channel = threading.Lock()


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
    if length > MAX_FRAME:
        raise ValueError('Frame too large')
    return json.loads(read_exact(length))


def send(value):
    data = json.dumps(value, separators=(',', ':')).encode()
    if len(data) > MAX_FRAME:
        raise ValueError('Frame too large')
    sys.stdout.buffer.write(struct.pack('>I', len(data)) + data)
    sys.stdout.buffer.flush()


class Relay(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path not in ('/v1/responses', '/v1/messages', '/anthropic/v1/messages', '/v1/messages?beta=true'):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('content-length', '0'))
        except ValueError:
            self.send_error(400)
            return
        if length < 1 or length > 4194304:
            self.send_error(413)
            return
        self.connection.settimeout(60)
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            return
        path = '/v1/messages' if self.path in ('/anthropic/v1/messages', '/v1/messages?beta=true') else self.path
        headers = {name: self.headers[name] for name in ('authorization', 'x-api-key', 'content-type', 'anthropic-beta') if name in self.headers}
        try:
            with channel:
                send({'path': path, 'headers': headers, 'body': base64.b64encode(body).decode()})
                first = receive()
                if first.get('kind') != 'start':
                    raise ValueError('Invalid response')
                self.send_response(first['status'])
                self.send_header('content-type', first['contentType'])
                self.send_header('connection', 'close')
                self.end_headers()
                while True:
                    frame = receive()
                    if frame.get('kind') == 'end':
                        break
                    if frame.get('kind') != 'data':
                        raise ValueError('Invalid response frame')
                    self.wfile.write(base64.b64decode(frame['data'], validate=True))
                    self.wfile.flush()
        except (EOFError, OSError, ValueError, KeyError):
            self.close_connection = True
        finally:
            self.close_connection = True


ThreadingHTTPServer(('0.0.0.0', 8080), Relay).serve_forever()
