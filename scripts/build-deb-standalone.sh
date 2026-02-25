#!/bin/bash
# Script de build du paquet .deb pour sfha (version standalone avec Node.js embarqué)
set -e

VERSION=$(node -p "require('./package.json').version")
PACKAGE_NAME="sfha_${VERSION}_amd64"
BUILD_DIR="build/${PACKAGE_NAME}"
NODE_VERSION="20.20.0"

echo "📦 Construction du paquet sfha v${VERSION} (standalone)..."

# Nettoyer
rm -rf build/ dist/
mkdir -p build/ vendor/

# Télécharger Node.js si nécessaire
if [ ! -f "vendor/node-v${NODE_VERSION}-linux-x64/bin/node" ]; then
  echo "📥 Téléchargement de Node.js v${NODE_VERSION}..."
  cd vendor
  curl -sL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o node.tar.xz
  tar xf node.tar.xz
  rm node.tar.xz
  cd ..
fi

# Compiler TypeScript
echo "🔨 Compilation TypeScript..."
npm run build

# Créer la structure du paquet
echo "📁 Création de la structure..."
mkdir -p "${BUILD_DIR}/DEBIAN"
mkdir -p "${BUILD_DIR}/usr/lib/sfha/dist"
mkdir -p "${BUILD_DIR}/usr/lib/sfha/node_modules"
mkdir -p "${BUILD_DIR}/usr/lib/sfha/bin"
mkdir -p "${BUILD_DIR}/usr/bin"
mkdir -p "${BUILD_DIR}/etc/sfha"
mkdir -p "${BUILD_DIR}/lib/systemd/system"

# Créer le fichier control (PAS de dépendance nodejs)
cat > "${BUILD_DIR}/DEBIAN/control" << 'CTRL'
Package: sfha
Version: VERSION_PLACEHOLDER
Architecture: amd64
Maintainer: ServerFlow <contact@serverflow.io>
Depends: corosync
Recommends: wireguard-tools
Section: admin
Priority: optional
Homepage: https://github.com/serverflow/sfha
Description: Haute Disponibilité légère pour Linux (standalone)
 sfha est un système de haute disponibilité léger qui remplace
 Pacemaker pour des cas d'usage simples.
 .
 Cette version inclut Node.js embarqué - aucune dépendance externe.
 .
 Fonctionnalités:
  - VIP flottantes avec failover automatique
  - Health checks HTTP, TCP et systemd
  - Gestion des services avec restart automatique
  - STONITH via Proxmox API
  - Mesh WireGuard intégré
CTRL
sed -i "s/VERSION_PLACEHOLDER/${VERSION}/" "${BUILD_DIR}/DEBIAN/control"

# Créer conffiles
cat > "${BUILD_DIR}/DEBIAN/conffiles" << 'CONF'
/etc/sfha/config.yml.example
CONF

# Créer postinst
cat > "${BUILD_DIR}/DEBIAN/postinst" << 'POST'
#!/bin/bash
set -e

mkdir -p /var/lib/sfha /var/run/sfha
systemctl daemon-reload
systemctl enable sfha.service 2>/dev/null || true

echo ""
echo "sfha installé avec succès! (version standalone)"
echo ""
echo "Configuration:"
echo "  1. Copiez /etc/sfha/config.yml.example vers /etc/sfha/config.yml"
echo "  2. Éditez la configuration"
echo "  3. Démarrez: systemctl start sfha"
echo ""

exit 0
POST
chmod 755 "${BUILD_DIR}/DEBIAN/postinst"

# Créer prerm
cat > "${BUILD_DIR}/DEBIAN/prerm" << 'PRERM'
#!/bin/bash
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  systemctl stop sfha.service 2>/dev/null || true
  systemctl disable sfha.service 2>/dev/null || true
fi
exit 0
PRERM
chmod 755 "${BUILD_DIR}/DEBIAN/prerm"

# Créer postrm
cat > "${BUILD_DIR}/DEBIAN/postrm" << 'POSTRM'
#!/bin/bash
set -e
if [ "$1" = "purge" ]; then
  rm -rf /var/lib/sfha /etc/sfha
fi
systemctl daemon-reload 2>/dev/null || true
exit 0
POSTRM
chmod 755 "${BUILD_DIR}/DEBIAN/postrm"

# Copier Node.js embarqué
echo "📋 Copie de Node.js embarqué..."
cp "vendor/node-v${NODE_VERSION}-linux-x64/bin/node" "${BUILD_DIR}/usr/lib/sfha/bin/node"
chmod 755 "${BUILD_DIR}/usr/lib/sfha/bin/node"

# Copier les fichiers JS compilés
echo "📋 Copie des fichiers JS..."
cp -r dist/* "${BUILD_DIR}/usr/lib/sfha/dist/"
cp package.json "${BUILD_DIR}/usr/lib/sfha/"

# Copier node_modules (résoudre les symlinks pnpm)
echo "📋 Copie des dépendances..."
cp -rL node_modules/* "${BUILD_DIR}/usr/lib/sfha/node_modules/" 2>/dev/null || true

# Copier les locales
cp -r locales "${BUILD_DIR}/usr/lib/sfha/"

# Créer le wrapper script qui utilise le Node embarqué
cat > "${BUILD_DIR}/usr/bin/sfha" << 'WRAPPER'
#!/bin/bash
exec /usr/lib/sfha/bin/node /usr/lib/sfha/dist/cli.js "$@"
WRAPPER
chmod 755 "${BUILD_DIR}/usr/bin/sfha"

# Copier la configuration exemple
if [ -f "config/config.yml.example" ]; then
  cp config/config.yml.example "${BUILD_DIR}/etc/sfha/"
fi

# Créer le service systemd
cat > "${BUILD_DIR}/lib/systemd/system/sfha.service" << 'SERVICE'
[Unit]
Description=sfha - Système de Haute Disponibilité léger
After=network.target
Wants=corosync.service
Documentation=https://github.com/serverflow/sfha

[Service]
Type=simple
WorkingDirectory=/usr/lib/sfha
ExecStart=/usr/lib/sfha/bin/node /usr/lib/sfha/dist/cli.js run
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sfha

[Install]
WantedBy=multi-user.target
SERVICE

# Calculer la taille installée
INSTALLED_SIZE=$(du -sk "${BUILD_DIR}" | cut -f1)
echo "Installed-Size: ${INSTALLED_SIZE}" >> "${BUILD_DIR}/DEBIAN/control"

# Construire le paquet
echo "🏗️ Construction du paquet .deb..."
dpkg-deb -Zxz --build --root-owner-group "${BUILD_DIR}"

mv "build/${PACKAGE_NAME}.deb" "./"
rm -rf build/

SIZE=$(ls -lh "sfha_${VERSION}_amd64.deb" | awk '{print $5}')
echo ""
echo "✅ Paquet créé: sfha_${VERSION}_amd64.deb (${SIZE})"
echo ""
echo "📦 Ce paquet est STANDALONE - Node.js est embarqué"
echo "   Aucune dépendance externe requise (sauf corosync)"
echo ""
echo "Installation: sudo dpkg -i sfha_${VERSION}_amd64.deb"
