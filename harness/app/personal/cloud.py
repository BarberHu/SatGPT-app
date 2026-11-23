"""Typed management operations, separate from model-authored Python."""
import re
from urllib.parse import quote
import requests
from .oauth import EE_READ, EE_WRITE, STORAGE
from .settings import PersonalError


def project_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', value):
        raise PersonalError(400, 'Enter a valid Google Cloud project ID.')
    return value


def asset_name(value):
    if not isinstance(value, str) or len(value) > 1024:
        raise PersonalError(400, 'Invalid Earth Engine asset ID.')
    if value.startswith('users/'):
        value = 'projects/earthengine-legacy/assets/' + value
    if not re.fullmatch(r'projects/[A-Za-z0-9_-]+/assets(?:/[A-Za-z0-9_.-]+)*', value) or any(
            part in {'.', '..'} for part in value.split('/')):
        raise PersonalError(400, 'Use a projects/…/assets/… or users/… asset ID.')
    return value


class Cloud:
    def __init__(self, oauth):
        self.oauth = oauth

    def ee(self, owner, method, path, body=None, scopes=(EE_READ,)):
        token = self.oauth.token(owner, scopes)
        try:
            response = requests.request(method, 'https://earthengine.googleapis.com/v1/' + path,
                headers={'Authorization': 'Bearer ' + token}, json=body, timeout=60)
        except requests.RequestException as exc:
            raise PersonalError(503, 'Earth Engine is unreachable. Check your connection and retry.') from exc
        if response.status_code >= 400:
            code = response.status_code
            message = {401: 'Reconnect your Google account.', 403: 'This account lacks Earth Engine permission for this resource or project.',
                       404: 'The Earth Engine resource was not found.', 409: 'The destination asset already exists.',
                       429: 'Earth Engine quota is temporarily exhausted.'}.get(code, 'Earth Engine could not complete this operation.')
            raise PersonalError(code if code in {400, 401, 403, 404, 409, 429} else 502, message)
        return response.json() if response.content else {}

    def verify(self, owner, project):
        project_id(project)
        result = self.ee(owner, 'POST', f'projects/{project}/value:compute',
                         {'expression': {'constantValue': 2}})
        if result.get('result') != 2:
            raise PersonalError(502, 'Earth Engine project verification did not return the expected result.')
        return True

    def asset(self, owner, name):
        return self.ee(owner, 'GET', quote(asset_name(name), safe='/'))

    def assets(self, owner, parent, page_token=''):
        path = quote(asset_name(parent), safe='/') + ':listAssets?pageSize=100'
        if page_token:
            if len(page_token) > 4096:
                raise PersonalError(400, 'Invalid page token.')
            path += '&pageToken=' + quote(page_token, safe='')
        return self.ee(owner, 'GET', path)

    def import_asset(self, owner, upload):
        manifest = {'name': upload['asset_id']}
        uri = 'gs://' + upload['bucket'] + '/' + upload['object']
        if upload['kind'] == 'raster':
            manifest['tilesets'] = [{'sources': [{'uris': [uri]}]}]
            # Metadata only: never resample or infer a new NoData value.
            manifest['bands'] = [{'id': name, 'tilesetBandIndex': i} for i, name in enumerate(upload['metadata']['bands'])]
            kind, field = 'image', 'imageManifest'
        else:
            manifest['sources'] = [{'uris': [uri], 'primaryGeometryColumn': '.geo', 'crs': 'EPSG:4326'}]
            manifest['columnDataTypeOverrides'] = upload['metadata']['column_types']
            kind, field = 'table', 'tableManifest'
        return self.ee(owner, 'POST', f"projects/{upload['project']}/{kind}:import",
                       {field: manifest, 'description': 'SatGPT upload ' + upload['id'],
                        'overwrite': False, 'requestId': upload['request_id']}, scopes=(EE_WRITE,))

    def operation(self, owner, name, cancel=False):
        if not re.fullmatch(r'projects/[A-Za-z0-9_-]+/operations/[A-Za-z0-9_-]+', name):
            raise PersonalError(502, 'Earth Engine returned an unsupported operation name.')
        return self.ee(owner, 'POST' if cancel else 'GET', name + (':cancel' if cancel else ''),
                       {} if cancel else None, scopes=(EE_WRITE,))

    def find_import(self, owner, upload):
        token = ''
        for _ in range(5):
            path = f"projects/{upload['project']}/operations?pageSize=100" + ('&pageToken=' + quote(token, safe='') if token else '')
            page = self.ee(owner, 'GET', path, scopes=(EE_WRITE,))
            matches = [row for row in page.get('operations', []) if
                       row.get('metadata', {}).get('description') == 'SatGPT upload ' + upload['id']]
            if len(matches) > 1:
                raise PersonalError(409, 'More than one matching remote import exists. Inspect the Earth Engine task history.')
            if matches:
                return matches[0]
            token = page.get('nextPageToken', '')
            if not token:
                return None
        raise PersonalError(409, 'Remote import reconciliation exceeded five pages. Inspect the Earth Engine task history before retrying.')

    def storage_client(self, owner, project=None):
        from google.cloud import storage
        from google.oauth2.credentials import Credentials
        conn = self.oauth.store.connection(owner)
        return storage.Client(project=project or conn['project'], credentials=Credentials(self.oauth.token(owner, (STORAGE,))))

    def stage(self, owner, upload, path):
        blob = self.storage_client(owner, upload['project']).bucket(upload['bucket']).blob(upload['object'])
        blob.metadata = {'satgpt_sha256': upload['sha256'], 'satgpt_upload': upload['id']}
        try:
            blob.upload_from_filename(str(path), if_generation_match=0, timeout=120)
        except Exception as exc:
            # A response can be lost after a successful upload. Match content before reusing.
            try:
                blob.reload(timeout=30)
                if blob.metadata.get('satgpt_sha256') == upload['sha256'] and blob.metadata.get('satgpt_upload') == upload['id']:
                    return
            except Exception:
                pass
            raise PersonalError(502, 'Cloud Storage upload failed. Check bucket access and retry.') from exc

    def cleanup(self, owner, upload):
        if not upload.get('object', '').startswith('satgpt/' + owner + '/' + upload['id'] + '/'):
            raise PersonalError(400, 'Refusing to clean an unmanaged object.')
        try:
            blob = self.storage_client(owner, upload['project']).bucket(upload['bucket']).blob(upload['object'])
            if blob.exists(timeout=30):
                blob.reload(timeout=30)
                if blob.metadata.get('satgpt_upload') != upload['id']:
                    raise PersonalError(409, 'The staging object no longer belongs to this upload.')
                blob.delete(if_generation_match=blob.generation, timeout=30)
        except PersonalError:
            raise
        except Exception as exc:
            raise PersonalError(502, 'Staging cleanup is pending; no Earth Engine asset was deleted.') from exc
