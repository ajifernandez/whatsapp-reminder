# Makefile - WhatsApp Reminder
# Empaqueta la version portable para Windows.
#
# La carpeta portable (dist/whatsapp-reminder-portable) trae ya empaquetados
# los binarios pesados: chrome/, bin/node.exe y node_modules/. Esos NO se
# regeneran aqui (se instalan/actualizan a mano cuando cambian dependencias).
# Este objetivo solo refresca el codigo fuente y vuelve a comprimir el ZIP.

PORTABLE_DIR := dist/whatsapp-reminder-portable
ZIP_NAME     := whatsapp-reminder-portable_v3.zip
ZIP          := dist/$(ZIP_NAME)

# Ficheros sueltos de codigo/doc que se copian de la raiz al portable.
# NO se tocan: chrome/, bin/, node_modules/, Iniciar.bat, LEEME.txt, data/
SYNC_FILES := server.js update.js package.json README.md MANUAL_USUARIO.md

.PHONY: prepare_portable_dist clean_portable_runtime

prepare_portable_dist:
	@test -d "$(PORTABLE_DIR)" || { echo "ERROR: falta $(PORTABLE_DIR)"; exit 1; }
	@echo ">> Comprobando sintaxis de server.js..."
	@node -c server.js
	@echo ">> Copiando ficheros de codigo..."
	@cp -f $(SYNC_FILES) "$(PORTABLE_DIR)/"
	@echo ">> Sincronizando renderer/ y vendor/..."
	@rsync -a --delete renderer/ "$(PORTABLE_DIR)/renderer/"
	@rsync -a --delete vendor/   "$(PORTABLE_DIR)/vendor/"
	@$(MAKE) --no-print-directory clean_portable_runtime
	@echo ">> Regenerando ZIP..."
	@rm -f "$(ZIP)"
	@cd dist && zip -rq "$(ZIP_NAME)" whatsapp-reminder-portable
	@echo ">> Hecho:"
	@du -sh "$(ZIP)"

# Deja el portable limpio: sin cache de WhatsApp Web (evita el cuelgue en
# Windows), sin sesion previa ni citas de pruebas.
clean_portable_runtime:
	@echo ">> Limpiando cache/sesion/citas del portable..."
	@rm -rf "$(PORTABLE_DIR)/.wwebjs_cache" "$(PORTABLE_DIR)/.wwebjs_auth"
	@rm -f  "$(PORTABLE_DIR)/data/citas.json"
