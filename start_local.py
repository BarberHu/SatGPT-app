"""Start the experimental local application without repository admin/model secrets."""
import argparse
import os
from pathlib import Path
import threading
import webbrowser


def main():
    parser = argparse.ArgumentParser(description='Run SatGPT locally with your Google account')
    parser.add_argument('--port', type=int, default=3313)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--import-existing', action='store_true', help='Copy this experiment’s old state before starting; sources are preserved')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Choose a port between 1024 and 65535.')
    # Set before importing backend modules; local startup deliberately skips .env.
    os.environ['SATGPT_RUN_MODE'] = 'local'
    from harness.app.local_runtime import LocalRuntime
    origin = f'http://127.0.0.1:{args.port}'
    runtime = LocalRuntime(origin=origin)
    runtime.acquire()
    if args.import_existing:
        from harness.app.local_migration import import_existing
        import_existing(Path(__file__).resolve().parent, runtime)
    from harness.app.local_app import create_app
    import uvicorn
    if not args.no_browser:
        timer = threading.Timer(1.5, lambda: webbrowser.open(origin + '/?mode=agent'))
        timer.daemon = True
        timer.start()
    print('SatGPT local application:', origin)
    print('Your data stays on this computer; Google and model requests go directly to those services.')
    uvicorn.run(create_app(runtime), host='127.0.0.1', port=args.port, workers=1,
                proxy_headers=False, access_log=False)


if __name__ == '__main__':
    main()
