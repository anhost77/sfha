#!/bin/bash
# Script de build du paquet .deb pour sfha
# Crée un binaire standalone avec Node.js embarqué
set -e

VERSION=$(node -p "require('./package.json').version")
PACKAGE_NAME="sfha_${VERSION}_amd64"
BUILD_DIR="build/${PACKAGE_NAME}"

echo "📦 Construction du paquet sfha v${VERSION} (standalone)..."

# Nettoyer
rm -rf build/ dist/
mkdir -p build/ bin/

# Compiler TypeScript
echo "🔨 Compilation TypeScript..."
npm run build

# Construire le binaire standalone avec pkg
echo "📦 Construction du binaire standalone..."
npx pkg . --targets node20-linux-x64 --output bin/sfha

# Vérifier le binaire
if [ ! -f "bin/sfha" ]; then
  echo "❌ Erreur: le binaire n'a pas été créé"
  exit 1
fi

file bin/sfha
ls -lh bin/sfha

# Créer la structure du paquet
echo "📁 Création de la structure..."
mkdir -p "${BUILD_DIR}/DEBIAN"
mkdir -p "${BUILD_DIR}/usr/bin"
mkdir -p "${BUILD_DIR}/usr/lib/sfha"
mkdir -p "${BUILD_DIR}/etc/sfha"
mkdir -p "${BUILD_DIR}/lib/systemd/system"

# Copier les fichiers DEBIAN
cp debian/control "${BUILD_DIR}/DEBIAN/"
cp debian/conffiles "${BUILD_DIR}/DEBIAN/"
cp debian/postinst "${BUILD_DIR}/DEBIAN/"
cp debian/prerm "${BUILD_DIR}/DEBIAN/"
cp debian/postrm "${BUILD_DIR}/DEBIAN/"
chmod 755 "${BUILD_DIR}/DEBIAN/postinst"
chmod 755 "${BUILD_DIR}/DEBIAN/prerm"
chmod 755 "${BUILD_DIR}/DEBIAN/postrm"

# Mettre à jour la version dans control
sed -i "s/Version: .*/Version: ${VERSION}/" "${BUILD_DIR}/DEBIAN/control"

# Copier le binaire standalone directement dans /usr/bin
cp bin/sfha "${BUILD_DIR}/usr/bin/sfha"
chmod 755 "${BUILD_DIR}/usr/bin/sfha"

# Copier les locales (pour référence/override éventuel)
cp -r locales "${BUILD_DIR}/usr/lib/sfha/"

# Copier la configuration exemple
cp config/config.yml.example "${BUILD_DIR}/etc/sfha/"

# Copier le service systemd
cp debian/sfha.service "${BUILD_DIR}/lib/systemd/system/"

# Calculer la taille installée (en Ko)
INSTALLED_SIZE=$(du -sk "${BUILD_DIR}" | cut -f1)
echo "Installed-Size: ${INSTALLED_SIZE}" >> "${BUILD_DIR}/DEBIAN/control"

# Construire le paquet (avec xz pour compatibilité Debian 11+)
echo "🏗️ Construction du paquet .deb..."
dpkg-deb -Zxz --build --root-owner-group "${BUILD_DIR}"

# Déplacer le paquet
mv "build/${PACKAGE_NAME}.deb" "./"

# Nettoyer
rm -rf build/

echo ""
echo "✅ Paquet créé: sfha_${VERSION}_amd64.deb"
echo ""
echo "📋 Ce paquet NE NÉCESSITE PLUS Node.js"
echo "   Le binaire embarque son propre runtime Node.js"
echo ""
echo "Installation:"
echo "  sudo dpkg -i sfha_${VERSION}_amd64.deb"
echo ""
echo "Ou avec apt:"
echo "  sudo apt install ./sfha_${VERSION}_amd64.deb"
