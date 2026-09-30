# Snap-packaged terminals (VS Code) inject libraries and schemas that break gjs
# and gnome-shell, so those targets run in a clean environment.
CLEAN_ENV = env -i HOME=$(HOME) PATH=/usr/bin:/bin XDG_RUNTIME_DIR=$(XDG_RUNTIME_DIR) LANG=C.UTF-8
.PHONY: test package install smoke dev-link reload nested demo-assets
test:
	node --test tests/*.test.js
	python3 -m unittest discover -s tests -p 'test_*.py' -v
	$(CLEAN_ENV) gjs -m tests/helpers.gjs.js
	glib-compile-schemas --strict schemas
	for f in *.js lib/*.js modules/*.js; do node --check $$f || exit 1; done
package:
	python3 scripts/package.py
install:
	python3 scripts/install.py
smoke:
	$(CLEAN_ENV) python3 scripts/smoke.py
demo-assets: smoke
	python3 scripts/export_demo_assets.py
dev-link:
	@rm -rf $(HOME)/.local/share/gnome-shell/extensions/ledge@shiv2077
	@ln -sfn $(CURDIR) $(HOME)/.local/share/gnome-shell/extensions/ledge@shiv2077
	glib-compile-schemas --strict schemas
	@gnome-extensions enable ledge@shiv2077 || { echo "GNOME has not seen ledge@shiv2077 yet. Log out and back in once, then run make reload."; exit 1; }
reload: dev-link
	gnome-extensions disable ledge@shiv2077 && gnome-extensions enable ledge@shiv2077
	@test -f $(HOME)/.local/share/gnome-shell/extensions/ledge@shiv2077/extension.js
	@grep -q '_onOverviewShowing' $(HOME)/.local/share/gnome-shell/extensions/ledge@shiv2077/extension.js
# GJS caches ES modules, so edited JS needs a fresh shell. This runs one in a window.
nested: dev-link
	$(CLEAN_ENV) WAYLAND_DISPLAY=$(WAYLAND_DISPLAY) DISPLAY=$(DISPLAY) dbus-run-session -- gnome-shell --nested --wayland
