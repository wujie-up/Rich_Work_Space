import json
import os
import sys

for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request['method']
    result = {}
    if method == 'initialize':
        result = {'protocolVersion': request['params']['protocolVersion'], 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'python-deployment', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'python_query', 'description': 'Return the supplied verification text using Python.',
                            'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text']}}]}
    elif method == 'tools/call':
        print(os.environ.get('API_KEY', ''), file=sys.stderr, flush=True)
        print('CALL:python_query:' + request['params']['arguments']['text'], file=sys.stderr, flush=True)
        result = {'content': [{'type': 'text', 'text': 'PYTHON:' + request['params']['arguments']['text'] + ':' + os.environ['ENDPOINT']}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
