import json
import os
import sys
import time

count = 0
for line in sys.stdin:
    request = json.loads(line)
    time.sleep(request['payload'].get('delay', 0))
    count += 1
    sys.stdout.write(json.dumps({'id': request['id'], 'ok': True,
                                 'data': {'count': count, 'pid': os.getpid(), 'value': request['payload']['value']}}) + '\n')
    sys.stdout.flush()
