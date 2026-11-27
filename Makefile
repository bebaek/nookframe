.DEFAULT_GOAL := help
.PHONY: help restart install-restart-helper

help:
	@printf '%s\n' 'make restart                 Queue a native user-service restart' 'make install-restart-helper  Install the helper from a host terminal'

restart:
	@state=$$(systemctl --user show nookframe-restart.service -p LoadState --value) || exit 1; \
	if [ "$$state" = not-found ]; then echo 'Missing restart helper. From a host terminal run: make install-restart-helper' >&2; exit 1; fi; \
	[ "$$state" = loaded ] || { echo "Restart helper not loaded: $$state" >&2; exit 1; }; \
	dir=$$(systemctl --user show nookframe-restart.service -p WorkingDirectory --value) && [ "$$(realpath -- "$$dir")" = "$$(pwd -P)" ] || { echo 'Restart helper does not target this checkout' >&2; exit 1; }; \
	systemctl --user start --no-block nookframe-restart.service && echo 'Restart queued.'

install-restart-helper:
	@python3 scripts/install-restart-helper.py
	@systemctl --user daemon-reload
