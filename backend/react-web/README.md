The React build is generated in `dist/` by `npm run build` before compiling Go.
This tracked file keeps Go builds working before Node is installed. Without the
build, API and shared modules remain available, but the UI and worker return 503.
Generated assets are not committed.
