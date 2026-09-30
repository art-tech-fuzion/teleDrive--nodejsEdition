/**
 * TeleDrive Distribution Builder & Minifier
 * 
 * Compresses and regenerates the `dist/` directory for production deployment:
 * - Minifies CSS and HTML
 * - Strips comments and compresses JavaScript safely
 * - Adds security `index.php` to all subdirectories
 * - Validates syntax of all output files
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Directories/files to ignore during build
const IGNORE_PATTERNS = [
    'node_modules',
    '.git',
    '.github',
    'dist',
    'temp_chunks',
    '.code-review-graph',
    '.DS_Store',
    'docs',
    '.env', // Do not copy live .env with secrets into dist; copy .env.example instead
    'CHANGELOG.md',
    'README.md',
    'build-dist.js'
];

function shouldIgnore(relPath) {
    const parts = relPath.split(path.sep);
    return IGNORE_PATTERNS.some(pat => parts.includes(pat) || relPath === pat || relPath.startsWith(pat + path.sep));
}

// -----------------------------------------------------------------------------
// Minification Utilities
// -----------------------------------------------------------------------------

function minifyCSS(css) {
    return css
        // Remove comments
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        // Remove whitespace around symbols
        .replace(/\s*([\{\}\:\;\,\>])\s*/g, '$1')
        .replace(/\;}/g, '}')
        .trim();
}

function minifyHTML(html) {
    return html
        // Remove comments
        .replace(/<!--[\s\S]*?-->/g, '')
        // Reduce whitespace between HTML tags
        .replace(/>\s+</g, '><')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Robust JS Comment and Whitespace Stripper
 * Preserves strings (', ", `) and regex literals while removing comments.
 */
function compressJS(code, filename = '') {
    let output = '';
    let inString = false;
    let stringChar = '';
    let inTemplate = false;
    let inRegex = false;
    let inComment = false;
    let commentType = '';
    let isEscaped = false;

    for (let i = 0; i < code.length; i++) {
        const char = code[i];
        const nextChar = code[i + 1];

        // Inside a comment
        if (inComment) {
            if (commentType === 'single' && (char === '\n' || char === '\r')) {
                inComment = false;
                output += '\n';
            } else if (commentType === 'multi' && char === '*' && nextChar === '/') {
                inComment = false;
                i++; // skip '/'
            }
            continue;
        }

        // Inside a string literal (' or ")
        if (inString) {
            output += char;
            if (char === '\\') {
                isEscaped = !isEscaped;
            } else if (char === stringChar && !isEscaped) {
                inString = false;
            } else {
                isEscaped = false;
            }
            continue;
        }

        // Inside a template literal (`)
        if (inTemplate) {
            output += char;
            if (char === '\\') {
                isEscaped = !isEscaped;
            } else if (char === '`' && !isEscaped) {
                inTemplate = false;
            } else {
                isEscaped = false;
            }
            continue;
        }

        // Inside a regular expression literal
        if (inRegex) {
            output += char;
            if (char === '\\') {
                isEscaped = !isEscaped;
            } else if (char === '/' && !isEscaped) {
                inRegex = false;
            } else {
                isEscaped = false;
            }
            continue;
        }

        // Start of single-line comment
        if (char === '/' && nextChar === '/') {
            inComment = true;
            commentType = 'single';
            i++;
            continue;
        }

        // Start of multi-line comment
        if (char === '/' && nextChar === '*') {
            inComment = true;
            commentType = 'multi';
            i++;
            continue;
        }

        // Start of string
        if (char === '\'' || char === '"') {
            inString = true;
            stringChar = char;
            isEscaped = false;
            output += char;
            continue;
        }

        // Start of template literal
        if (char === '`') {
            inTemplate = true;
            isEscaped = false;
            output += char;
            continue;
        }

        // Start of regex (heuristics: preceded by =, (, [, ,, :, !, &, |, ?, ;, return, or start of line)
        if (char === '/') {
            const prevNonWs = output.trim().slice(-1);
            if (!prevNonWs || /[=(,:\?!&|;{\[]/.test(prevNonWs) || output.trim().endsWith('return')) {
                inRegex = true;
                isEscaped = false;
                output += char;
                continue;
            }
        }

        output += char;
    }

    // Clean up lines: trim trailing spaces and empty blank lines
    const compressed = output
        .split('\n')
        .map(line => line.trimEnd())
        .filter((line, idx, arr) => {
            if (line.trim().length === 0) {
                // Keep at most 1 blank line between blocks
                return idx > 0 && arr[idx - 1].trim().length > 0;
            }
            return true;
        })
        .join('\n');

    // Syntax check
    try {
        new vm.Script(compressed, { filename });
    } catch (syntaxErr) {
        console.warn(`⚠️  Compression fallback for ${filename}: ${syntaxErr.message}`);
        // Return original if regex parser had edge-case
        return code;
    }

    return compressed;
}

// -----------------------------------------------------------------------------
// Recursive Directory Walker & Processor
// -----------------------------------------------------------------------------

function collectFiles(dir, base = '') {
    let files = [];
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = path.join(base, entry);
        if (shouldIgnore(relPath)) continue;

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            files = files.concat(collectFiles(fullPath, relPath));
        } else {
            files.push({ fullPath, relPath, size: stat.size });
        }
    }
    return files;
}

function ensureDirSync(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// -----------------------------------------------------------------------------
// Main Build Execution
// -----------------------------------------------------------------------------

function build() {
    console.log('🚀 Starting TeleDrive dist build & compression...');
    const startTime = Date.now();

    // 1. Clean existing dist folder
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    ensureDirSync(DIST_DIR);

    // 2. Collect all files from source
    const files = collectFiles(ROOT_DIR);
    const createdDirs = new Set([DIST_DIR]);

    let totalOriginalSize = 0;
    let totalCompressedSize = 0;
    let processedCount = 0;

    for (const file of files) {
        const destPath = path.join(DIST_DIR, file.relPath);
        const destDir = path.dirname(destPath);
        
        ensureDirSync(destDir);
        createdDirs.add(destDir);

        const ext = path.extname(file.relPath).toLowerCase();
        const originalContent = fs.readFileSync(file.fullPath);
        const originalSize = originalContent.length;
        totalOriginalSize += originalSize;

        let finalContent = originalContent;

        if (ext === '.css') {
            const minified = minifyCSS(originalContent.toString('utf8'));
            finalContent = Buffer.from(minified, 'utf8');
        } else if (ext === '.html') {
            const minified = minifyHTML(originalContent.toString('utf8'));
            finalContent = Buffer.from(minified, 'utf8');
        } else if (ext === '.js') {
            const compressed = compressJS(originalContent.toString('utf8'), file.relPath);
            finalContent = Buffer.from(compressed, 'utf8');
        } else if (file.relPath === 'package.json') {
            try {
                const pkg = JSON.parse(originalContent.toString('utf8'));
                if (pkg.scripts) {
                    // In production dist, build is already done, so provide a safe no-op
                    pkg.scripts.build = "echo 'Production build ready'";
                }
                finalContent = Buffer.from(JSON.stringify(pkg, null, 2), 'utf8');
            } catch (e) {
                finalContent = originalContent;
            }
        } else {
            // Keep unchanged (.svg, .json, .example, .php, .htaccess)
            finalContent = originalContent;
        }

        fs.writeFileSync(destPath, finalContent);
        totalCompressedSize += finalContent.length;
        processedCount++;

        const savings = originalSize > 0 
            ? ((1 - finalContent.length / originalSize) * 100).toFixed(1)
            : 0;

        console.log(`  ✓ ${file.relPath.padEnd(35)} ${(originalSize / 1024).toFixed(1)} KB -> ${(finalContent.length / 1024).toFixed(1)} KB (${savings}% saved)`);
    }

    // 3. Place security index.php ("Silence is golden") in every subfolder of dist
    const silenceContent = '<?php\n// Silence is golden.\n';
    for (const dir of createdDirs) {
        const indexPath = path.join(dir, 'index.php');
        if (!fs.existsSync(indexPath)) {
            fs.writeFileSync(indexPath, silenceContent, 'utf8');
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const overallSavings = ((1 - totalCompressedSize / totalOriginalSize) * 100).toFixed(1);

    console.log('\n========================================================');
    console.log(`🎉 TeleDrive dist generated successfully in ${elapsed}s!`);
    console.log(`📦 Processed: ${processedCount} files`);
    console.log(`📊 Size: ${(totalOriginalSize / 1024).toFixed(1)} KB -> ${(totalCompressedSize / 1024).toFixed(1)} KB (Total savings: ${overallSavings}%)`);
    console.log(`📁 Destination: ${DIST_DIR}`);
    console.log('========================================================\n');
}

build();
