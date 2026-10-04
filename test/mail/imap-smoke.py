"""Disposable, offline TLS IMAP fixture; no provider credentials or model calls."""
import base64
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import tempfile
import threading

with tempfile.TemporaryDirectory(prefix='pi-mail-native-') as temp:
    root = Path(temp)
    cert, key = root / 'cert.pem', root / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], check=True, capture_output=True)
    message = (b'From: Sender <sender@example.test>\r\nTo: fixture@gmail.com\r\n'
               b'Subject: Native mail fixture\r\nMessage-ID: <native-fixture@example.test>\r\n'
               b'Date: Sat, 26 Sep 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\n'
               b'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n'
               b'--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nFixture body, untrusted email data.\r\n'
               b'--fixture\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="unsafe.sh"\r\n\r\nDO_NOT_EXECUTE\r\n'
               b'--fixture--\r\n')
    listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(); listener.settimeout(.2)
    port = listener.getsockname()[1]
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
    stopping = threading.Event(); failures = []; commands = []; trace = []; authenticated = []

    def serve():
        while not stopping.is_set():
            try: raw, _ = listener.accept()
            except socket.timeout: continue
            except OSError: break
            try:
                with context.wrap_socket(raw, server_side=True) as conn, conn.makefile('rb') as stream:
                    conn.settimeout(15)
                    def send(text): conn.sendall(text.encode())
                    send('* OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2 SASL-IR UIDPLUS] Fixture\r\n')
                    while True:
                        line = stream.readline().decode().rstrip('\r\n')
                        if not line: break
                        tag, command = line.split(' ', 1); upper = command.upper()
                        verb = upper.split()[0]; commands.append(verb if verb != 'UID' else 'UID ' + upper.split()[1])
                        if verb != 'AUTHENTICATE': trace.append(command)
                        if verb == 'CAPABILITY':
                            send('* CAPABILITY IMAP4rev1 AUTH=XOAUTH2 SASL-IR UIDPLUS\r\n' + tag + ' OK capability\r\n')
                        elif verb == 'AUTHENTICATE':
                            pieces = command.split()
                            assert pieces[1] == 'XOAUTH2'
                            if len(pieces) > 2: payload = pieces[2]
                            else:
                                send('+ \r\n'); payload = stream.readline().decode().strip()
                            assert base64.b64decode(payload) == b'user=fixture@gmail.com\x01auth=Bearer fixture-access-token\x01\x01'
                            authenticated.append(True); send(tag + ' OK authenticated\r\n')
                        elif verb == 'LIST':
                            send('* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren) "/" "[Gmail]/All Mail"\r\n* LIST (\\HasNoChildren) "/" "[Gmail]/Spam"\r\n* LIST (\\HasNoChildren) "/" "[Gmail]/Trash"\r\n' + tag + ' OK list\r\n')
                        elif verb in ('SELECT', 'EXAMINE'):
                            send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] uidvalidity\r\n* OK [UIDNEXT 2] uidnext\r\n' + tag + ' OK [READ-ONLY] selected\r\n')
                        elif upper.startswith('UID FETCH '):
                            sequence = command.split()[2]
                            if not sequence.startswith('2'):
                                fields = 'UID 1'
                                if 'FLAGS' in upper: fields += ' FLAGS ()'
                                if 'RFC822.SIZE' in upper: fields += f' RFC822.SIZE {len(message)}'
                                if 'INTERNALDATE' in upper: fields += ' INTERNALDATE "26-Sep-2026 12:00:00 +0000"'
                                if 'BODY' in upper:
                                    assert 'BODY.PEEK[]' in upper, 'Fetching must not mark messages read'
                                    send(f'* 1 FETCH ({fields} BODY[] {{{len(message)}}}\r\n'); conn.sendall(message); send(')\r\n')
                                else: send(f'* 1 FETCH ({fields})\r\n')
                            send(tag + ' OK fetch\r\n')
                        elif verb == 'LOGOUT':
                            send('* BYE fixture complete\r\n' + tag + ' OK logout\r\n'); break
                        elif verb == 'NOOP': send(tag + ' OK noop\r\n')
                        else: raise AssertionError('Unexpected/unsafe IMAP command: ' + verb)
            except Exception as error: failures.append(type(error).__name__ + ': ' + str(error))
    worker = threading.Thread(target=serve, daemon=True); worker.start()

    def node(code, *args):
        result = subprocess.run(['node', '--input-type=module', '-e', code, *map(str, args)], text=True, capture_output=True, check=True)
        return result.stdout
    code = '''import {MailStore} from '/app/dist/mail/store.js';
import {prepareConfig} from '/app/dist/mail/config.js';
const store=new MailStore(process.argv[1]);
const account={alias:process.argv[2],provider:'gmail',email:'fixture@gmail.com',polling:false,oauth:{clientId:'fixture',refreshToken:'fixture',accessToken:'fixture',expiresAt:0}};
store.saveAccount(account);console.log(JSON.stringify(prepareConfig(store,account)));'''
    paths = json.loads(node(code, root / 'mail', 'personal'))
    config = Path(paths['mbsync']).read_text()
    config = config.replace('Host "imap.gmail.com"', 'Host "localhost"').replace('Port 993', f'Port {port}')
    config = config.replace('CertificateFile "/etc/ssl/certs/ca-certificates.crt"', f'CertificateFile "{cert}"')
    config = re.sub(r'^PassCmd .*$', 'PassCmd "/usr/bin/printf fixture-access-token"', config, flags=re.M)
    assert 'Host "localhost"' in config and 'pi-mail-token' not in config
    Path(paths['mbsync']).write_text(config)
    try:
        cur = root / 'mail/maildir/personal/INBOX/cur'
        for iteration in range(2):
            sync = subprocess.run(['mbsync', '-q', '-c', paths['mbsync'], '-a'], text=True, capture_output=True, timeout=25)
            assert sync.returncode == 0, (sync.stderr, failures, trace)
            if iteration == 0:
                # Local seen/deleted flags and a locally created message must not
                # trigger remote STORE, APPEND, or EXPUNGE on the next sync.
                local = (list(cur.iterdir()) + list((cur.parent / 'new').iterdir()))[0]
                local.rename(cur / (local.name.split(':2,')[0] + ':2,ST'))
                (cur / 'local-only:2,').write_bytes(message.replace(b'native-fixture@example.test', b'local-only@example.test'))
        for folder in ['INBOX', '[Gmail]/All Mail', '[Gmail]/Spam', '[Gmail]/Trash']:
            maildir = root / 'mail/maildir/personal' / folder
            assert list((maildir / 'cur').iterdir()) or list((maildir / 'new').iterdir()), folder
        for local in cur.iterdir():
            if local.name.startswith('local-only'): local.unlink()
            elif ':2,' in local.name: local.rename(local.with_name(local.name.split(':2,')[0] + ':2,'))
        assert not failures, failures
        assert len(authenticated) == 2
        assert not any(command in ['UID STORE', 'APPEND', 'EXPUNGE', 'CREATE', 'DELETE', 'CLOSE'] for command in commands), commands
    finally:
        stopping.set(); listener.close(); worker.join(timeout=2)
    subprocess.run(['notmuch', '--config=' + paths['notmuch'], 'new', '--quiet'], check=True, capture_output=True)
    # Identical Message-ID in another account must retain independent unread state.
    secondary = json.loads(node(code, root / 'mail', 'secondary'))
    (root / 'mail/maildir/secondary/INBOX/cur/fixture:2,S').write_bytes(message)
    subprocess.run(['notmuch', '--config=' + secondary['notmuch'], 'new', '--quiet'], check=True, capture_output=True)
    for name in ['personal', 'secondary']:
        (root / f'mail/state/{name}.json').write_text(json.dumps({'status': 'ok', 'attemptedAt': '2026-09-26T12:00:00Z', 'lastSuccess': '2026-09-26T12:00:00Z'}))
    env = {**os.environ, 'MAIL_DIR': str(root / 'mail'), 'PUBLIC_ORIGIN': 'http://localhost:3000'}
    def cli(*args):
        result = subprocess.run(['mailctl', *args], env=env, text=True, capture_output=True, check=True)
        return json.loads(result.stdout)
    # A failed download can still be indexed/searched locally, without making
    # another IMAP connection or erasing the quota failure.
    (root / 'mail/state/personal.json').write_text(json.dumps({'status': 'failed', 'attemptedAt': '2026-09-26T12:00:00Z', 'error': 'MAIL_QUOTA'}))
    cli('index', 'personal')
    assert cli('account', 'status', 'personal')['accounts'][0]['sync']['error'] == 'MAIL_QUOTA'
    # Recover a persisted index failure through the scheduled, local-only path.
    # The disposable IMAP server is stopped, so no provider connection is possible.
    sync_before = (root / 'mail/state/personal.json').read_bytes()
    (root / 'mail/state/personal/index-status.json').write_text(json.dumps({'status': 'failed', 'attemptedAt': '2026-09-26T12:00:00Z', 'failures': 1}))
    cli('jobs', 'enable', 'personal')
    assert cli('jobs', 'status', 'personal')['jobs'][0]['nextWork'] == 'index'
    assert cli('index', 'personal', '--scheduled')['index']['status'] == 'ok'
    assert (root / 'mail/state/personal.json').read_bytes() == sync_before
    cli('jobs', 'pause', 'personal')
    all_mail = cli('search')
    assert next(f for f in all_mail['freshness'] if f['account'] == 'personal')['partial'] is True
    assert len(all_mail['results']) == 2, all_mail
    unread = cli('search', '--unread')
    assert len(unread['results']) == 1 and unread['results'][0]['account'] == 'personal', (all_mail, unread)
    assert len(cli('search', '--unread', '--query', 'from:sender@example.test')['results']) == 1
    assert len(cli('search', '--unread', '--query', '*')['results']) == 1
    body = cli('read', unread['results'][0]['ref'])
    assert body['untrustedEmail'] is True
    assert 'Fixture body' in json.dumps(body) and 'unsafe.sh' in json.dumps(body)
    assert 'DO_NOT_EXECUTE' not in json.dumps(body)
    print('Offline mail smoke passed: real TLS/XOAUTH2 mbsync, two pull-only syncs, BODY.PEEK, independent notmuch indexes/unread state, bounded read, attachments omitted.')
