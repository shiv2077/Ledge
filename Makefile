.PHONY: test package install smoke dev-link reload nested demo-assets
test:
	node --test tests/*.test.js
	python3 -m unittest discover -s tests -p 'test_*.py' -v
	glib-compile-schemas --strict schemas
	node --check extension.js
	node --check model.js
	node --check design.js
	node --check draw.js
	node --check glyphs.js
	node --check prefs.js
package:
	python3 scripts/package.py
install:
	python3 scripts/install.py
smoke:
	python3 scripts/smoke.py
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
	dbus-run-session -- gnome-shell --nested --wayland
