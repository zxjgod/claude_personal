@echo off
node -e "console.log('stdin TTY:', process.stdin.isTTY, 'stdout TTY:', process.stdout.isTTY)"
