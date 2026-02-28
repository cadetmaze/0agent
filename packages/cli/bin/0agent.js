#!/usr/bin/env node

// Check Node version before anything else
const [major] = process.versions.node.split('.').map(Number)
if (major < 22) {
    console.error(`\n  0agent requires Node.js 22+. You have ${process.versions.node}.\n  Install: https://nodejs.org\n`)
    process.exit(1)
}

// Import and run the CLI
import('../dist/cli/index.js').catch((err) => {
    console.error('Failed to start 0agent:', err.message)
    process.exit(1)
})
