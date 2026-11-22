import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import httpx

from harness.app.geocoding_worker import Geocoder, MAX_RESPONSE_BYTES, PUBLIC_HOST


JINSHUI = {
    'display_name': '金水区, 郑州市, 河南省, 中国',
    'lat': '34.8', 'lon': '113.66', 'addresstype': 'district',
    'boundingbox': ['34.73', '34.92', '113.61', '113.85'],
    'address': {'city': '郑州市', 'state': '河南省', 'country_code': 'cn', 'road': '示例路'},
    'osm_type': 'relation', 'osm_id': 7,
}


def check_ranked_candidates():
    other = {**JINSHUI, 'display_name': 'Jinshui, Another City', 'osm_id': 8,
             'boundingbox': ['80', '70', '20', '30']}
    requests = []

    def upstream(request):
        requests.append(dict(request.url.params))
        return httpx.Response(200, json=[JINSHUI, JINSHUI, other, {'lat': 'inf'}])

    with httpx.Client(transport=httpx.MockTransport(upstream)) as client:
        service = Geocoder(client, 'https://fixture.invalid/search')
        args = {'query': ' 郑州市   金水区 ', 'country_code': 'CN', 'language': 'zh-CN'}
        value = service.search(args)
        assert value['status'] == 'ok'
        assert 'OpenStreetMap' in value['attribution']
        first, second = value['candidates']
        assert first == {
            'label': JINSHUI['display_name'], 'type': 'district', 'position': [113.66, 34.8],
            'bounds': [113.61, 34.73, 113.85, 34.92], 'osm_ref': 'relation/7',
            'administrative': {'city': '郑州市', 'state': '河南省', 'country_code': 'cn'},
        }
        assert second['label'] == 'Jinshui, Another City'
        assert 'bounds' not in second
        assert service.search({**args, 'query': '郑州市 金水区', 'country_code': 'cn'}) == value
        assert requests == [{'q': '郑州市 金水区', 'limit': '3', 'format': 'jsonv2',
                             'addressdetails': '1', 'countrycodes': 'cn', 'accept-language': 'zh-cn'}]
        assert len(service.search({**args, 'language': 'en', 'limit': 1})['candidates']) == 1
        assert requests[-1]['accept-language'] == 'en'


def check_input(args, status):
    requests = []

    def upstream(request):
        requests.append(request)
        return httpx.Response(200, json=[])

    with httpx.Client(transport=httpx.MockTransport(upstream)) as client:
        service = Geocoder(client, 'https://fixture.invalid/search')
        for _ in range(2):
            assert service.search(args)['status'] == status
    assert len(requests) == (1 if status == 'no_match' else 0)


def check_upstream_failure(http_status, content, status):
    requests = []

    def upstream(request):
        requests.append(request)
        if http_status is None:
            raise httpx.ReadTimeout('fixture timeout', request=request)
        return httpx.Response(http_status, content=content)

    with httpx.Client(transport=httpx.MockTransport(upstream)) as client:
        service = Geocoder(client, 'https://fixture.invalid/search')
        for _ in range(2):
            value = service.search({'query': '测试'})
            assert value['status'] == status
            assert value['candidates'] == []
    assert len(requests) == 2


class GeocodingTests(unittest.TestCase):
    def test_candidates(self):
        check_ranked_candidates()

    def test_input_and_no_match(self):
        for args, status in [
            ({'query': '  '}, 'invalid_query'), ({'query': 'x', 'limit': True}, 'invalid_query'),
            ({'query': 'x', 'limit': 6}, 'invalid_query'), ({'query': 'x', 'country_code': '123'}, 'invalid_query'),
            ({'query': 'x', 'language': 'en,zh'}, 'invalid_query'), ({'query': 'unknown'}, 'no_match'),
        ]:
            with self.subTest(args=args):
                check_input(args, status)

    def test_upstream_failures(self):
        for http_status, content, status in [
            (200, b'invalid json', 'upstream_error'), (200, b'{}', 'upstream_error'),
            (200, json.dumps([{'display_name': 'Invalid point', 'lat': 91, 'lon': 30}]), 'upstream_error'),
            (200, b'x' * (MAX_RESPONSE_BYTES + 1), 'upstream_error'),
            (503, b'unavailable', 'upstream_error'), (429, b'busy', 'rate_limited'),
            (None, b'', 'upstream_timeout'),
        ]:
            with self.subTest(http_status=http_status, status=status):
                check_upstream_failure(http_status, content, status)

    def test_public_rate_limit_and_cache(self):
        sent = []

        def upstream(request):
            sent.append(request.url.params['q'])
            if sent[-1] == 'busy':
                return httpx.Response(429)
            return httpx.Response(200, json=[JINSHUI])

        with tempfile.TemporaryDirectory() as directory, \
                httpx.Client(transport=httpx.MockTransport(upstream)) as client, \
                patch('harness.app.geocoding_worker.sleep') as wait:
            lock = Path(directory) / 'state' / 'nominatim-rate.sqlite3'
            service = Geocoder(client, f'https://{PUBLIC_HOST}/search', lock)
            assert service.search({'query': 'Zhengzhou'})['status'] == 'ok'
            wait.assert_called_once_with(1.1)
            wait.reset_mock()
            assert service.search({'query': 'Zhengzhou'})['status'] == 'ok'
            wait.assert_not_called()
            assert service.search({'query': 'busy'})['status'] == 'rate_limited'
            wait.assert_called_once_with(1.1)
            assert sent == ['Zhengzhou', 'busy']

    def test_public_rate_limit_fails_closed(self):
        def unexpected_request(_):
            self.fail('Sent a public request without acquiring the shared lock')

        with tempfile.TemporaryDirectory() as directory, \
                httpx.Client(transport=httpx.MockTransport(unexpected_request)) as client:
            endpoint = f'https://{PUBLIC_HOST}/search'
            lock = Path(directory) / 'nominatim-rate.sqlite3'
            assert Geocoder(client, endpoint).search({'query': 'Zhengzhou'})['status'] == 'upstream_error'
            assert Geocoder(client, endpoint, directory).search({'query': 'Zhengzhou'})['status'] == 'upstream_error'
            holder = sqlite3.connect(lock)
            try:
                holder.execute('BEGIN IMMEDIATE')
                with patch('harness.app.geocoding_worker.PUBLIC_LOCK_TIMEOUT', .05):
                    assert Geocoder(client, endpoint, lock).search({'query': 'Zhengzhou'})['status'] == 'rate_limited'
            finally:
                holder.close()
