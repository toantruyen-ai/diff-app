VERSION=1.0.15
npm version $VERSION --no-git-tag-version
git add package.json
git commit -m "chore: bump version to $VERSION"
git tag v$VERSION
git push origin main
git push origin v$VERSION