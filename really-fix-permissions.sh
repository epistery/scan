#!/bin/bash
# Really fix the permissions - the directory is 755 instead of 775/770

echo "=== Fixing Directory Permissions ==="
echo ""

echo "Current directory permissions:"
stat /media/space/mongodb | grep Access
echo ""

echo "The directory is 0755 (r-xr-xr-x) - owner can't write!"
echo "Changing to 0775 (rwxrwxr-x)..."
sudo chmod 775 /media/space/mongodb
echo ""

echo "New permissions:"
stat /media/space/mongodb | grep Access
echo ""

echo "Testing write as mongodb user..."
sudo -u mongodb touch /media/space/mongodb/test-really-write
sudo -u mongodb rm /media/space/mongodb/test-really-write
echo "✓ Write test successful!"
echo ""

echo "Now run: bash fix-permissions-and-fcv.sh"
