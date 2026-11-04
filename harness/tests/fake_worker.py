import json
import os
import sys

count = 0
for line in sys.stdin:
    request = json.loads(line)
    count += 1
    sys.stdout.write(json.dumps({'id': request['id'], 'ok': True,
                                 'data': {'count': count, 'pid': os.getpid(), 'value': request['payload']['value']}}) + '\n')
    sys.stdout.flush()
