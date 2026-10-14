const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const simpleGit = require('simple-git');

let fetch;
try {
    import('node-fetch').then(module => {
        fetch = module.default;
    }).catch(() => {
        fetch = require('node-fetch');
    });
} catch (error) {
    console.error('Failed to import node-fetch:', error);
    fetch = async (url, options) => {
        const https = require('https');
        const http = require('http');
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.request(url, options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        json: async () => JSON.parse(data)
                    });
                });
            });
            req.on('error', reject);
            if (options && options.body) req.write(options.body);
            req.end();
        });
    };
}

const info = {
    id: 'cloud-saves',
    name: 'Cloud Saves (Characters + Chats only)',
    description: 'Sync only characters, chats and messages via GitHub. Everything else is ignored.',
    version: '1.1.0-chats-only',
};

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_BRANCH = 'main';

const DEFAULT_CONFIG = {
    repo_url: '',
    branch: DEFAULT_BRANCH,
    username: '',
    github_token: '',
    display_name: '',
    is_authorized: false,
    last_save: null,
    current_save: null,
    has_temp_stash: false,
    autoSaveEnabled: false,
    autoSaveInterval: 30,
    autoSaveTargetTag: '',
};

let currentOperation = null;
let autoSaveBackendTimer = null;

// Only these paths will be tracked
const TRACKED_PATHS = [
    'default-user/characters',
    'default-user/chats',
    'default-user/group chats',
    'default-user/groups',
];

async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(data);
        config.branch = config.branch || DEFAULT_BRANCH;
        config.autoSaveEnabled = config.autoSaveEnabled === undefined ? DEFAULT_CONFIG.autoSaveEnabled : config.autoSaveEnabled;
        config.autoSaveInterval = config.autoSaveInterval === undefined ? DEFAULT_CONFIG.autoSaveInterval : config.autoSaveInterval;
        config.autoSaveTargetTag = config.autoSaveTargetTag === undefined ? DEFAULT_CONFIG.autoSaveTargetTag : config.autoSaveTargetTag;
        return config;
    } catch (error) {
        console.warn('Failed to read or parse config, creating default:', error.message);
        await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
}

async function saveConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getGitInstance(cwd = DATA_DIR) {
    const options = {
        baseDir: cwd,
        binary: 'git',
        maxConcurrentProcesses: 6,
    };
    const git = simpleGit(options);
    const config = await readConfig();

    if (cwd === DATA_DIR && config.repo_url && config.github_token) {
        try {
            const remotes = await git.getRemotes(true);
            const origin = remotes.find(r => r.name === 'origin');
            const originalUrl = config.repo_url;
            let authUrl = originalUrl;

            if (originalUrl.startsWith('https://') && !originalUrl.includes('@')) {
                authUrl = originalUrl.replace('https://', `https://x-access-token:${config.github_token}@`);
            }
            if (origin && origin.refs.push !== authUrl) {
                 console.log(`[cloud-saves] Configuring remote 'origin' with auth URL for ${path.basename(cwd)}`);
                 await git.remote(['set-url', 'origin', authUrl]);
            } else if (!origin && originalUrl) {
                 console.log(`[cloud-saves] Adding remote 'origin' with auth URL for ${path.basename(cwd)}`);
                 await git.addRemote('origin', authUrl);
            }
        } catch (error) {
            console.warn(`[cloud-saves] Failed to configure authenticated remote for ${path.basename(cwd)}:`, error.message);
        }
    }

    return git;
}

function handleGitError(error, operation = 'Git operation') {
    console.error(`[cloud-saves] ${operation} failed:`, error.message);
    return {
        success: false,
        message: `${operation} failed`,
        details: error.message || error.stack || 'Unknown simple-git error',
        error: error
    };
}

async function isGitInitialized() {
    try {
        const git = simpleGit(DATA_DIR);
        const gitDir = path.join(DATA_DIR, '.git');
        try {
           await fs.access(gitDir);
        } catch {
           return false;
        }
        return await git.checkIsRepo();
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error("[cloud-saves] Error checking git initialization:", error);
        }
        return false;
    }
}

async function addGitkeepRecursively(directory) {
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        let hasGitkeep = false;
        const subDirectories = [];

        for (const entry of entries) {
            if (entry.isFile() && entry.name === '.gitkeep') {
                hasGitkeep = true;
            }
            if (entry.isDirectory() && entry.name !== '.git') {
                subDirectories.push(path.join(directory, entry.name));
            }
        }

        if (!hasGitkeep) {
            const gitkeepPath = path.join(directory, '.gitkeep');
            try {
                await fs.access(gitkeepPath);
            } catch (e) {
                try {
                    await fs.writeFile(gitkeepPath, '');
                    console.log(`[cloud-saves] Created .gitkeep in ${path.relative(DATA_DIR, directory) || '.'}`);
                } catch (writeError) {
                    console.error(`[cloud-saves] Failed to create .gitkeep in ${path.relative(DATA_DIR, directory) || '.'}:`, writeError);
                }
            }
        }

        for (const subDir of subDirectories) {
            await addGitkeepRecursively(subDir);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
             console.error(`[cloud-saves] Error processing directory ${path.relative(DATA_DIR, directory) || '.'} for .gitkeep:`, error);
        }
    }
}

// Create selective .gitignore — only characters + chats
async function createSelectiveGitignore() {
    const gitignorePath = path.join(DATA_DIR, '.gitignore');
    const content = `# Cloud Saves — only characters, chats and messages
# Ignore everything by default
*

# Allow directories
!*/
!default-user/
default-user/*

# Characters
!default-user/characters/
!default-user/characters/**

# Chats and messages
!default-user/chats/
!default-user/chats/**

# Group chats
!default-user/group chats/
!default-user/group chats/**

# Groups
!default-user/groups/
!default-user/groups/**

# Allow .gitkeep
!**/.gitkeep
`;
    await fs.writeFile(gitignorePath, content, 'utf8');
    console.log(`[cloud-saves] Created selective .gitignore (characters + chats + groups only)`);
}

async function initGitRepo() {
    if (await isGitInitialized()) {
        console.log('[cloud-saves] Git repository already initialized in data directory.');
        // Always refresh .gitignore in case of old version
        await createSelectiveGitignore();
        return { success: true, message: 'Git repository already initialized in data directory (selective mode)' };
    }

    console.log('[cloud-saves] Initializing Git repository in data directory (characters + chats only):', DATA_DIR);
    try {
        const git = simpleGit(DATA_DIR);
        await git.init();
        console.log('[cloud-saves] git init successful');

        // Create selective .gitignore
        await createSelectiveGitignore();

        // Add .gitkeep only to tracked folders
        for (const relPath of TRACKED_PATHS) {
            const fullPath = path.join(DATA_DIR, relPath);
            try {
                await fs.mkdir(fullPath, { recursive: true });
                await addGitkeepRecursively(fullPath);
            } catch (e) {
                console.warn(`[cloud-saves] Failed to prepare ${relPath}:`, e.message);
            }
        }

        return { success: true, message: 'Git repository initialized successfully (characters + chats + groups only)' };
    } catch (error) {
        return handleGitError(error, 'Initialize Git repository');
    }
}

async function configureRemote(repoUrl) {
    try {
        const git = await getGitInstance();
        const remotes = await git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');

        let authUrl = repoUrl;
        const config = await readConfig();
        if (repoUrl.startsWith('https://') && config.github_token && !repoUrl.includes('@')) {
            authUrl = repoUrl.replace('https://', `https://x-access-token:${config.github_token}@`);
        }

        if (origin) {
            if (origin.refs.push !== authUrl) {
                console.log('[cloud-saves] Updating remote origin URL.');
                await git.remote(['set-url', 'origin', authUrl]);
            }
        } else {
            console.log('[cloud-saves] Adding remote origin.');
            await git.addRemote('origin', authUrl);
        }
        return { success: true, message: 'Remote repository configuration checked/updated successfully' };
    } catch (error) {
        return handleGitError(error, 'Configure remote repository');
    }
}

async function createSave(name, description) {
    try {
        currentOperation = 'create_save';
        console.log(`[cloud-saves] Creating new save (characters + chats only): ${name}`);
        const config = await readConfig();
        const git = await getGitInstance();
        const branchToPush = config.branch || DEFAULT_BRANCH;

        const encodedName = Buffer.from(name).toString('base64url');
        const tagName = `save_${Date.now()}_${encodedName}`;
        const nowTimestamp = new Date().toISOString();
        const tagMessage = description || `Save: ${name}`;
        const fullTagMessage = `${tagMessage}\nLast Updated: ${nowTimestamp}`;

        // .gitignore already limits what will be added
        await git.add('.');
        const status = await git.status();
        let commitNeeded = !status.isClean();

        if (commitNeeded) {
            console.log('[cloud-saves] Committing changes...');
            try {
                await git.commit(`Save: ${name}`);
            } catch (commitError) {
                if (commitError.message.includes('nothing to commit')) {
                     console.log('[cloud-saves] Nothing to commit.');
                     commitNeeded = false;
                } else {
                    throw commitError;
                }
            }
        }

        console.log('[cloud-saves] Creating tag...');
        await git.addAnnotatedTag(tagName, fullTagMessage);

        console.log('[cloud-saves] Pushing changes...');
        const currentBranchStatus = await git.branch();
        const currentBranch = currentBranchStatus.current;

        if (commitNeeded && currentBranch === branchToPush && !currentBranchStatus.detached) {
            console.log(`[cloud-saves] Pushing branch: ${currentBranch}`);
            try {
                 await git.push('origin', currentBranch);
            } catch (pushError) {
                console.warn(`[cloud-saves] Failed to push branch ${currentBranch}:`, pushError.message);
            }
        }

        await git.push(['origin', tagName]);

        config.last_save = {
            name: name,
            tag: tagName,
            timestamp: nowTimestamp,
            description: description || ''
        };
        await saveConfig(config);

        return {
            success: true,
            message: 'Save created successfully (characters + chats only)',
            saveData: {
                ...config.last_save,
                name: name,
                createdAt: nowTimestamp,
                updatedAt: nowTimestamp
            }
        };
    } catch (error) {
        return handleGitError(error, `Create save ${name}`);
    } finally {
        currentOperation = null;
    }
}

async function listSaves() {
    try {
        currentOperation = 'list_saves';
        console.log('[cloud-saves] Fetching save list');
        const git = await getGitInstance();

        console.log('[cloud-saves] Fetching and pruning remote tags...');
        await git.fetch(['origin', '--tags', '--force', '--prune-tags']);

        const formatString = "%(refname:short)%00%(creatordate:iso)%00%(taggername)%00%(subject)%00%(contents)";
        const tagOutput = await git.raw('tag', '-l', 'save_*', '--sort=-creatordate', `--format=${formatString}`);

        if (!tagOutput) {
             return { success: true, saves: [] };
        }

        const saves = tagOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\0');
            if (parts.length < 5) return null;

            const tagName = parts[0];
            const createdAt = new Date(parts[1]).toISOString();
            const taggerName = parts[2] || 'Unknown';
            const subject = parts[3];
            const body = parts[4] || '';

            let name = tagName;
            let description = subject;
            let updatedAt = createdAt;

            const bodyLines = body.split('\n');
            const lastUpdatedLine = bodyLines.find(l => l.startsWith('Last Updated:'));
            if (lastUpdatedLine) {
                const timestampStr = lastUpdatedLine.replace('Last Updated:', '').trim();
                const parsedDate = new Date(timestampStr);
                if (!isNaN(parsedDate)) {
                    updatedAt = parsedDate.toISOString();
                }
            }

            const tagNameMatch = tagName.match(/^save_\d+_(.+)$/);
            if (tagNameMatch) {
                try {
                    const encodedName = tagNameMatch[1];
                    name = Buffer.from(encodedName, 'base64url').toString('utf8');
                } catch (decodeError) {
                    console.warn(`[cloud-saves] Failed to decode save name (${tagName}):`, decodeError);
                    name = tagNameMatch[1];
                }
            }

            return {
                name: name,
                tag: tagName,
                commit: null,
                createdAt: createdAt,
                updatedAt: updatedAt,
                description: description.trim(),
                creator: taggerName
            };
        }).filter(Boolean);

        return { success: true, saves: saves };
    } catch (error) {
        return handleGitError(error, 'List saves');
    } finally {
        currentOperation = null;
    }
}

async function loadSave(tagName) {
    try {
        currentOperation = 'load_save';
        console.log(`[cloud-saves] Loading save: ${tagName}`);
        const git = await getGitInstance();
        const config = await readConfig();

        await git.fetch(['origin', '--tags']);
        const tags = await git.tags(['-l', tagName]);
        if (!tags || !tags.all.includes(tagName)) {
            return { success: false, message: 'Specified save tag not found' };
        }

        const status = await git.status();
        let stashCreated = false;
        if (!status.isClean()) {
            console.log('[cloud-saves] Unsaved changes detected, creating temporary stash before loading');
            const stashResult = await git.stash(['push', '-u', '-m', 'Temporary stash before loading save']);
            stashCreated = stashResult && !stashResult.includes('No local changes to save');
             if (stashCreated) {
                 console.log('[cloud-saves] Temporary stash created successfully');
                 config.has_temp_stash = true;
             } else {
                 console.warn('[cloud-saves] Failed to create temporary stash or no changes to save');
                 config.has_temp_stash = false;
             }
        } else {
             config.has_temp_stash = false;
        }

        const commit = await git.revparse([tagName]);
        if (!commit) {
            if(stashCreated) await git.stash(['pop']);
             return { success: false, message: 'Failed to get save commit hash' };
        }

        await git.checkout(commit);

        config.current_save = {
            tag: tagName,
            loaded_at: new Date().toISOString()
        };
        await saveConfig(config);

        return {
            success: true,
            message: 'Save loaded successfully',
            stashCreated: stashCreated
        };
    } catch (error) {
        try {
            const cfg = await readConfig();
            if (cfg.has_temp_stash) {
                const git = await getGitInstance();
                console.warn("[cloud-saves] Load failed, attempting to pop temporary stash...");
                await git.stash(['pop']);
                cfg.has_temp_stash = false;
                await saveConfig(cfg);
                console.warn("[cloud-saves] Temporary stash popped after load failure.");
            }
        } catch (popError) {
              console.error("[cloud-saves] Failed to pop temporary stash after load error:", popError);
        }
        return handleGitError(error, `Load save ${tagName}`);
    } finally {
        currentOperation = null;
    }
}

async function deleteSave(tagName) {
    try {
        currentOperation = 'delete_save';
        console.log(`[cloud-saves] Deleting save: ${tagName}`);
        const git = await getGitInstance();

        await git.tag(['-d', tagName]);
        console.log(`[cloud-saves] Local tag ${tagName} deleted (or did not exist)`);

        let remoteDeleteSuccess = false;
        try {
            await git.push(['origin', `:refs/tags/${tagName}`]);
            console.log(`[cloud-saves] Remote tag ${tagName} deleted`);
            remoteDeleteSuccess = true;
        } catch (pushError) {
            if (pushError.message.includes('remote ref does not exist') || pushError.message.includes('deletion of') ) {
                console.log(`[cloud-saves] Remote tag ${tagName} does not exist or was already deleted`);
                remoteDeleteSuccess = true;
            } else {
                 console.warn(`[cloud-saves] Failed to delete remote tag ${tagName}:`, pushError.message);
                 const config = await readConfig();
                 if (config.current_save && config.current_save.tag === tagName) {
                     config.current_save = null;
                     await saveConfig(config);
                 }
                 return {
                     success: true,
                     message: 'Local save deleted, but failed to delete remote save (possible network or permission issue)',
                     warning: true,
                     details: pushError.message
                 };
            }
        }

        const config = await readConfig();
        if (config.current_save && config.current_save.tag === tagName) {
            config.current_save = null;
            await saveConfig(config);
        }

        return { success: true, message: 'Save deleted successfully' };
    } catch (error) {
        return handleGitError(error, `Delete save ${tagName}`);
    } finally {
        currentOperation = null;
    }
}

async function renameSave(oldTagName, newName, description) {
    try {
        currentOperation = 'rename_save';
        console.log(`[cloud-saves] Renaming save: ${oldTagName} -> ${newName}`);
        const git = await getGitInstance();
        const config = await readConfig();

        const tags = await git.tags(['-l', oldTagName]);
         if (!tags || !tags.all.includes(oldTagName)) {
             return { success: false, message: 'Specified save tag not found' };
         }
        const commit = await git.revparse([oldTagName]);
        if (!commit) return { success: false, message: 'Failed to get save commit' };

        let oldDecodedName = oldTagName;
        const oldNameMatch = oldTagName.match(/^save_\d+_(.+)$/);
        if (oldNameMatch) {
            try { oldDecodedName = Buffer.from(oldNameMatch[1], 'base64url').toString('utf8'); } catch (e) { /* ignore */ }
        }

        const nowTimestamp = new Date().toISOString();
        const newDescription = description || `Save: ${newName}`;
        const fullNewMessage = `${newDescription}\nLast Updated: ${nowTimestamp}`;

        if (oldDecodedName === newName) {
            console.log(`[cloud-saves] Name unchanged, only updating tag description and timestamp: ${oldTagName}`);
            await git.tag(['-a', '-f', oldTagName, '-m', fullNewMessage, commit]);
            await git.push(['origin', oldTagName, '--force']);
             return { success: true, message: 'Save description and update time updated', oldTag: oldTagName, newTag: oldTagName, newName: newName };
        } else {
             console.log(`[cloud-saves] Name changed, performing full rename...`);
             const encodedNewName = Buffer.from(newName).toString('base64url');
             const newTagName = `save_${Date.now()}_${encodedNewName}`;

             console.log(`[cloud-saves] Creating new tag: ${newTagName}`);
             await git.addAnnotatedTag(newTagName, fullNewMessage, commit);

             console.log(`[cloud-saves] Pushing new tag: ${newTagName}`);
             try {
                await git.push('origin', newTagName);
             } catch (pushError) {
                  await git.tag(['-d', newTagName]);
                  throw pushError;
             }

             console.log(`[cloud-saves] Deleting old local tag: ${oldTagName}`);
             await git.tag(['-d', oldTagName]);

             console.log(`[cloud-saves] Deleting old remote tag: ${oldTagName}`);
             try {
                 await git.push(['origin', `:refs/tags/${oldTagName}`]);
             } catch(deleteRemoteError) {
                  if (!deleteRemoteError.message.includes('remote ref does not exist')) {
                      console.warn(`[cloud-saves] Failed to delete old remote tag ${oldTagName}:`, deleteRemoteError.message);
                  }
             }

            if (config.current_save && config.current_save.tag === oldTagName) {
                config.current_save.tag = newTagName;
                await saveConfig(config);
            }

            return { success: true, message: 'Save renamed successfully', oldTag: oldTagName, newTag: newTagName, newName: newName };
        }
    } catch (error) {
        return handleGitError(error, `Rename save ${oldTagName} -> ${newName}`);
    } finally {
        currentOperation = null;
    }
}

async function getSaveDiff(ref1, ref2) {
    try {
        currentOperation = 'get_save_diff';
        console.log(`[cloud-saves] Getting diff: ${ref1} <-> ${ref2}`);
        const git = simpleGit(DATA_DIR);
        const emptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

        try {
            await git.revparse(['--verify', ref1]);
        } catch (error) {
            if ((ref1.endsWith('^') || ref1.endsWith('~1')) && error.message.includes('unknown revision')) {
                console.warn(`[cloud-saves] Cannot resolve reference ${ref1}, may be parent of initial commit. Comparing with empty tree.`);
                ref1 = emptyTreeHash;
            } else if (ref1 === emptyTreeHash) {

            }
            else {
                 return { success: false, message: `Invalid or missing reference: ${ref1}`, details: error.message };
            }
        }
        try {
            await git.revparse(['--verify', ref2]);
        } catch (error) {
             return { success: false, message: `Invalid or missing reference: ${ref2}`, details: error.message };
        }

        let diffOutput;
        let changedFiles = [];
         try {
             if (ref1 === emptyTreeHash) {
                  console.log(`[cloud-saves] Comparing with empty tree (${ref2}), using 'git ls-tree' to show initial commit contents.`);
                 const lsTreeOutput = await git.raw('ls-tree', '-r', '--name-only', ref2);
                 if (!lsTreeOutput) return { success: true, changedFiles: [] };
                 changedFiles = lsTreeOutput.trim().split('\n').filter(Boolean).map(fileName => ({
                     status: 'A',
                     fileName: fileName
                 }));
                 return { success: true, changedFiles: changedFiles };
             } else {
                 diffOutput = await git.diff(['--name-status', ref1, ref2]);
             }
         } catch (diffError) {
              return handleGitError(diffError, `Get diff ${ref1} <-> ${ref2}`);
         }

        changedFiles = diffOutput.trim().split('\n')
            .filter(Boolean)
            .map(line => {
                const [status, ...fileParts] = line.split(/\s+/);
                const fileName = fileParts.join(' ');
                return { status, fileName };
            });

        return {
            success: true,
            changedFiles: changedFiles
        };
    } catch (error) {
        return handleGitError(error, `Get save diff ${ref1} <-> ${ref2}`);
    } finally {
        currentOperation = null;
    }
}

async function getGitStatus() {
    try {
        const git = simpleGit(DATA_DIR);
        const isInitialized = await isGitInitialized();

        let status = null;
        if (isInitialized) {
            status = await git.status();
        }

        let currentBranch = null;
        let isDetached = false;
        if (isInitialized) {
             try {
                 const branchSummary = await git.branch();
                 currentBranch = branchSummary.current;
                 isDetached = branchSummary.detached;
             } catch (branchError) {
                  console.warn('[cloud-saves] Failed to get branch info:', branchError.message);
             }
        }

        const config = await readConfig();
        const currentSave = config.current_save;

        const formattedStatus = {
             initialized: isInitialized,
             changes: status ? status.files.map(f => `${f.working_dir}${f.index} ${f.path}`) : [],
             currentBranch: isDetached ? null : currentBranch,
             currentSave: currentSave,
             isDetached: isDetached,
             ahead: status ? status.ahead : 0,
             behind: status ? status.behind : 0,
        };

        return formattedStatus;

    } catch (error) {
        console.error('Error getting Git status:', error);
        throw handleGitError(error, 'Get Git status');
    }
}

async function hasUnsavedChanges() {
    try {
        const git = simpleGit(DATA_DIR);
        if (!await isGitInitialized()) return false;
        const status = await git.status();
        return !status.isClean();
    } catch (error) {
         console.error('[cloud-saves] Error checking unsaved changes:', error);
         return false;
    }
}

async function checkTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { exists: false };
    }

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        if (stashList.total === 0) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { exists: false };
        }
        const tempStash = stashList.all.find(s => s.message.includes('Temporary stash before loading save'));
         if (!tempStash) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { exists: false };
         }

        return { exists: true };
    } catch (error) {
        console.error('[cloud-saves] Error checking stash list:', error);
        return { exists: config.has_temp_stash, error: 'Failed to check stash list' };
    }
}

async function applyTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found in config' };
    }

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        const stashMessageToFind = 'Temporary stash before loading save';
        const stashIndex = stashList.all.findIndex(s => s.message && s.message.includes(stashMessageToFind));

        if (stashIndex === -1) {
            console.warn('[cloud-saves] Temporary stash message not found in list. Clearing flag.');
            config.has_temp_stash = false;
            await saveConfig(config);
            return { success: false, message: `Stash with message "${stashMessageToFind}" not found in stash list` };
        }

        const stashRef = `stash@{${stashIndex}}`;

        console.log(`[cloud-saves] Applying temporary stash: ${stashRef}`);
        await git.stash(['apply', stashRef]);

        console.log(`[cloud-saves] Dropping temporary stash: ${stashRef}`);
        try {
            await git.stash(['drop', stashRef]);
        } catch (dropError) {
            console.error(`[cloud-saves] Failed to drop stash ${stashRef} after applying:`, dropError);
            config.has_temp_stash = false;
            await saveConfig(config);
            return handleGitError(dropError, `Applied successfully but failed to drop stash ${stashRef}`);
        }

        config.has_temp_stash = false;
        await saveConfig(config);

        return { success: true, message: 'Temporary stash applied and dropped successfully' };
    } catch (error) {
        return handleGitError(error, 'Apply temporary stash');
    }
}

async function discardTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found in config' };
    }

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        const stashMessageToFind = 'Temporary stash before loading save';
        const stashIndex = stashList.all.findIndex(s => s.message && s.message.includes(stashMessageToFind));

        if (stashIndex === -1) {
            console.warn('[cloud-saves] Temporary stash message not found in list. Clearing flag.');
            config.has_temp_stash = false;
            await saveConfig(config);
            return { success: true, message: `Stash with message "${stashMessageToFind}" already gone or not found` };
        }

        const stashRef = `stash@{${stashIndex}}`;

        console.log(`[cloud-saves] Dropping temporary stash: ${stashRef}`);
        await git.stash(['drop', stashRef]);

        config.has_temp_stash = false;
        await saveConfig(config);

        return { success: true, message: 'Temporary stash discarded' };
    } catch (error) {
        return handleGitError(error, 'Discard temporary stash');
    }
}

async function performAutoSave() {
    if (currentOperation) {
        console.log(`[Cloud Saves Auto] Skipping auto-save, operation in progress: ${currentOperation}`);
        return;
    }
    currentOperation = 'auto_save';
    let config;
    let git;
    try {
        config = await readConfig();
        if (!config.is_authorized || !config.autoSaveEnabled || !config.autoSaveTargetTag) {
            console.log('[Cloud Saves Auto] Auto-save conditions not met, skipping.');
            currentOperation = null;
            return;
        }

        const targetTag = config.autoSaveTargetTag;
        console.log(`[Cloud Saves Auto] Starting auto-overwrite to: ${targetTag}`);
        git = await getGitInstance();
        const branchToUse = config.branch || DEFAULT_BRANCH;

        let originalDescription = `Auto Save Overwrite: ${targetTag}`;
        try {
             const tagInfoRaw = await git.raw('tag', '-n1', '-l', targetTag, '--format=%(contents)');
             if (tagInfoRaw) {
                 originalDescription = tagInfoRaw.trim().split('\n')[0];
             }
        } catch (tagInfoError) {
             console.warn(`[Cloud Saves Auto] Failed to get old tag ${targetTag} info, using default description.`, tagInfoError.message);
        }

        await git.add('.');
        const status = await git.status();
        const hasChanges = !status.isClean();
        let newCommitHash;

        if (hasChanges) {
            const commitMessage = `Auto Save Overwrite: ${targetTag}`;
            try {
                const commitResult = await git.commit(commitMessage);
                 newCommitHash = commitResult.commit;
                 console.log('[Cloud Saves Auto] New auto-save commit hash:', newCommitHash);
                try {
                    await git.push('origin', branchToUse);
                } catch (pushCommitError) {
                    console.warn(`[Cloud Saves Auto] Failed to push auto-save commit to branch ${branchToUse}:`, pushCommitError.message);
                }
            } catch (commitError) {
                if (commitError.message.includes('nothing to commit')) {
                    console.log('[Cloud Saves Auto] No actual changes to commit during auto-save, using current HEAD');
                    newCommitHash = await git.revparse('HEAD');
                } else {
                     throw commitError;
                }
            }
        } else {
            console.log('[Cloud Saves Auto] No actual changes to commit during auto-save, using current HEAD');
            newCommitHash = await git.revparse('HEAD');
        }

        if (!newCommitHash) {
            throw new Error('Unable to determine commit hash for auto-save');
        }

        try {
             await git.tag(['-d', targetTag]);
        } catch (delLocalErr) { /* Ignore */ }
        try {
            await git.push(['origin', `:refs/tags/${targetTag}`]);
        } catch (delRemoteErr) {
            if (!delRemoteErr.message.includes('remote ref does not exist')) {
                 console.warn(`[Cloud Saves Auto] Problem deleting remote old tag ${targetTag}:`, delRemoteErr.message);
            }
        }

        const nowTimestampOverwrite = new Date().toISOString();
        const fullTagMessageOverwrite = `${originalDescription}\nLast Updated: ${nowTimestampOverwrite}`;
        await git.addAnnotatedTag(targetTag, fullTagMessageOverwrite, newCommitHash);

        try {
             await git.push('origin', targetTag);
        } catch (pushTagError) {
             await git.tag(['-d', targetTag]);
             throw pushTagError;
        }

        console.log(`[Cloud Saves Auto] Successfully auto-overwrote save: ${targetTag}`);

    } catch (error) {
        console.error(`[Cloud Saves Auto] Auto-overwrite failed (${config?.autoSaveTargetTag}):`, error);
    } finally {
        currentOperation = null;
    }
}

function setupBackendAutoSaveTimer() {
    if (autoSaveBackendTimer) {
        console.log('[Cloud Saves] Clearing existing backend auto-save timer.');
        clearInterval(autoSaveBackendTimer);
        autoSaveBackendTimer = null;
    }

    readConfig().then(config => {
        if (config.is_authorized && config.autoSaveEnabled && config.autoSaveTargetTag) {
            const intervalMinutes = config.autoSaveInterval > 0 ? config.autoSaveInterval : 30;
            let intervalMilliseconds = intervalMinutes * 60 * 1000;
            if (intervalMilliseconds < 60000) {
                 console.warn(`[Cloud Saves] Auto-save interval (${intervalMinutes} min) too short, adjusted to minimum 1 minute.`);
                 intervalMilliseconds = 60000;
            }
            console.log(`[Cloud Saves] Starting backend timed save, interval ${intervalMinutes} minutes, target: ${config.autoSaveTargetTag}`);
            autoSaveBackendTimer = setInterval(performAutoSave, intervalMilliseconds);
        } else {
            console.log('[Cloud Saves] Backend timed save not started (not authorized / disabled / no target).');
        }
    }).catch(err => {
        console.error('[Cloud Saves] Failed to read config before starting backend timer:', err);
    });
}

async function init(router) {
    console.log('[cloud-saves] Initializing Cloud Saves plugin (simple-git) — SELECTIVE MODE (characters + chats only)...');
    console.log('[cloud-saves] Plugin UI address (change port if not 8000): http://127.0.0.1:8000/api/plugins/cloud-saves/ui');

    try {
        router.use('/static', express.static(path.join(__dirname, 'public')));
        router.use(express.json());
        router.get('/ui', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        router.get('/info', (req, res) => {
            res.json(info);
        });

        router.get('/config', async (req, res) => {
            try {
                const config = await readConfig();
                const safeConfig = {
                    repo_url: config.repo_url || '',
                    display_name: config.display_name || '',
                    branch: config.branch || DEFAULT_BRANCH,
                    is_authorized: config.is_authorized || false,
                    username: config.username || null,
                    autoSaveEnabled: config.autoSaveEnabled || false,
                    autoSaveInterval: config.autoSaveInterval || 30,
                    autoSaveTargetTag: config.autoSaveTargetTag || '',
                    has_github_token: !!config.github_token,
                };
                res.json(safeConfig);
            } catch (error) {
                res.status(500).json({ success: false, message: 'Failed to read config', error: error.message });
            }
        });

        router.post('/config', async (req, res) => {
            try {
                const {
                    repo_url, github_token, display_name, branch, is_authorized,
                    autoSaveEnabled, autoSaveInterval, autoSaveTargetTag
                } = req.body;
                let currentConfig = await readConfig();

                currentConfig.repo_url = repo_url !== undefined ? repo_url.trim() : currentConfig.repo_url;
                if (github_token) {
                    currentConfig.github_token = github_token;
                }
                currentConfig.display_name = display_name !== undefined ? display_name.trim() : currentConfig.display_name;
                currentConfig.branch = branch !== undefined ? (branch.trim() || DEFAULT_BRANCH) : currentConfig.branch;
                if (is_authorized !== undefined) {
                    currentConfig.is_authorized = !!is_authorized;
                }
                if (autoSaveEnabled !== undefined) {
                    currentConfig.autoSaveEnabled = !!autoSaveEnabled;
                }
                if (autoSaveInterval !== undefined) {
                    const interval = parseFloat(autoSaveInterval);
                    if (isNaN(interval) || interval <= 0) {
                        return res.status(400).json({ success: false, message: 'Invalid auto-save interval. Please enter a number greater than 0.' });
                    }
                    currentConfig.autoSaveInterval = interval;
                }
                if (autoSaveTargetTag !== undefined) {
                    currentConfig.autoSaveTargetTag = autoSaveTargetTag.trim();
                }

                await saveConfig(currentConfig);
                setupBackendAutoSaveTimer();

                const safeConfig = {
                    repo_url: currentConfig.repo_url,
                    display_name: currentConfig.display_name,
                    branch: currentConfig.branch,
                    is_authorized: currentConfig.is_authorized,
                    username: currentConfig.username,
                    autoSaveEnabled: currentConfig.autoSaveEnabled,
                    autoSaveInterval: currentConfig.autoSaveInterval,
                    autoSaveTargetTag: currentConfig.autoSaveTargetTag
                };
                res.json({ success: true, message: 'Config saved successfully', config: safeConfig });
            } catch (error) {
                console.error('[cloud-saves] Failed to save config:', error);
                res.status(500).json({ success: false, message: 'Failed to save config', error: error.message });
            }
        });

        router.post('/authorize', async (req, res) => {
             let authGit;
            try {
                const { branch } = req.body;
                let config = await readConfig();
                const targetBranch = branch || config.branch || DEFAULT_BRANCH;

                if (!config.repo_url || !config.github_token) {
                    return res.status(400).json({ success: false, message: 'Repository URL and GitHub Token not configured. Please save settings first.' });
                }

                if (branch && config.branch !== targetBranch) {
                    config.branch = targetBranch;
                }
                config.is_authorized = false;

                const initResult = await initGitRepo();
                if (!initResult.success) {
                    return res.status(500).json({ success: false, message: initResult.message, details: initResult.details });
                }

                authGit = simpleGit(DATA_DIR);

                try {
                     console.log('[cloud-saves] Preparing initial commit (tracked paths only)...');
                     await authGit.add('.');
                     const status = await authGit.status();
                     if (!status.isClean()) {
                         console.log('[cloud-saves] Performing initial commit...');
                         try {
                             console.log('[cloud-saves] Configuring local Git identity for initial commit...');
                             await authGit.addConfig('user.name', 'Cloud Saves Plugin', false, 'local');
                             await authGit.addConfig('user.email', 'cloud-saves@plugin.local', false, 'local');
                         } catch (configError) {
                             console.error('[cloud-saves] Failed to configure local Git identity:', configError);
                         }
                         await authGit.commit('Initial commit (characters + chats only)');
                         console.log('[cloud-saves] Initial commit completed.');
                     } else {
                         console.log('[cloud-saves] No changes in data directory, skipping initial commit.');
                     }
                 } catch (initialCommitError) {
                      if (!initialCommitError.message.includes('nothing to commit')) {
                           console.error('[cloud-saves] Error during initial commit:', initialCommitError);
                           return res.status(500).json({ success: false, message: `Failed to create initial commit: ${initialCommitError.message}` });
                      }
                      console.log('[cloud-saves] Nothing to commit during initial commit (caught exception).');
                 }

                let authUrl = config.repo_url;
                if (config.repo_url.startsWith('https://') && !config.repo_url.includes('@')) {
                    authUrl = config.repo_url.replace('https://', `https://x-access-token:${config.github_token}@`);
                }
                const remotes = await authGit.getRemotes(true);
                const origin = remotes.find(r => r.name === 'origin');
                if (origin) {
                     if (origin.refs.push !== authUrl) {
                        await authGit.remote(['set-url', 'origin', authUrl]);
                     }
                } else {
                     await authGit.addRemote('origin', authUrl);
                }
                console.log('[cloud-saves] Remote repository configured');

                try {
                    await authGit.fetch(['origin', '--tags', '--prune', '--force']);
                    console.log("[cloud-saves] Tags fetched successfully.");
                } catch(fetchError) {
                     await saveConfig(config);
                     return res.status(400).json({
                         success: false,
                         message: 'Configuration error or insufficient permissions: cannot access remote repository or fetch tags. Check URL and Token permissions.',
                         details: fetchError.message
                     });
                }

                console.log(`[cloud-saves] Checking remote branch ${targetBranch}...`);
                let remoteBranchExists = false;
                 try {
                     const remoteHeads = await authGit.listRemote(['--heads', 'origin', targetBranch]);
                     remoteBranchExists = typeof remoteHeads === 'string' && remoteHeads.includes(`refs/heads/${targetBranch}`);
                 } catch (lsRemoteError) {
                      console.warn(`[cloud-saves] ls-remote check for branch ${targetBranch} failed, assuming it does not exist. Error:`, lsRemoteError.message);
                      remoteBranchExists = false;
                 }

                if (!remoteBranchExists) {
                    console.log(`[cloud-saves] Remote branch ${targetBranch} does not exist, attempting to create...`);
                    try {
                        const localBranches = await authGit.branchLocal();
                         if (!localBranches.all.includes(targetBranch)) {
                             console.log(`[cloud-saves] Creating local branch ${targetBranch}...`);
                             await authGit.checkout(['-b', targetBranch]);
                         } else {
                              await authGit.checkout(targetBranch);
                         }

                        console.log(`[cloud-saves] Pushing to create remote branch ${targetBranch}...`);
                        await authGit.push(['--set-upstream', 'origin', targetBranch]);
                        console.log(`[cloud-saves] Remote branch ${targetBranch} created successfully`);
                    } catch (createBranchError) {
                         console.error(`[cloud-saves] Failed to auto-create/push branch ${targetBranch}:`, createBranchError);
                         await saveConfig(config);
                         if (createBranchError.message.includes('non-fast-forward')) {
                              return res.status(500).json({ success: false, message: `Remote branch ${targetBranch} already exists but local history conflicts (non-fast-forward). Try resolving manually or choose another branch name.`, details: createBranchError.message });
                         }
                         return res.status(500).json({ success: false, message: `Unable to automatically create or sync remote branch ${targetBranch}. Error: ${createBranchError.message}`, details: createBranchError.message });
                    }
                } else {
                    console.log(`[cloud-saves] Remote branch ${targetBranch} already exists. Connection verified, not modifying local branch.`);
                }

                config.is_authorized = true;
                config.branch = targetBranch;

                try {
                    const validationResponse = await fetch('https://api.github.com/user', {
                        headers: { 'Authorization': `token ${config.github_token}` }
                    });
                    if (validationResponse.ok) {
                        const userData = await validationResponse.json();
                        config.username = userData.login || null;
                    } else {
                        console.warn(`[cloud-saves] Failed to get GitHub username: ${validationResponse.status}`);
                    }
                } catch (fetchUserError) {
                    console.warn('[cloud-saves] Network error while getting GitHub username:', fetchUserError.message);
                }

                await saveConfig(config);
                setupBackendAutoSaveTimer();

                const safeConfig = {
                    repo_url: config.repo_url,
                    display_name: config.display_name,
                    branch: config.branch,
                    is_authorized: config.is_authorized,
                    username: config.username,
                    autoSaveEnabled: config.autoSaveEnabled,
                    autoSaveInterval: config.autoSaveInterval,
                    autoSaveTargetTag: config.autoSaveTargetTag
                };

                res.json({ success: true, message: 'Authorization and configuration successful (selective mode)', config: safeConfig });

            } catch (error) {
                 console.error("[cloud-saves] Critical error during authorization:", error);
                 try {
                      let cfg = await readConfig();
                      cfg.is_authorized = false;
                      await saveConfig(cfg);
                 } catch (saveErr) { /* Ignore */ }
                 setupBackendAutoSaveTimer();
                res.status(500).json({ success: false, message: 'Error during authorization process', error: error.message });
            }
        });

        router.get('/status', async (req, res) => {
            try {
                const status = await getGitStatus();
                const tempStashStatus = await checkTempStash();
                res.json({ success: true, status: { ...status, tempStash: tempStashStatus } });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message || 'Failed to get status', details: error.details });
            }
        });

        router.get('/saves', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const result = await listSaves();
                res.json(result);
            } catch (error) {
                res.status(500).json(error);
            }
        });

        router.post('/saves', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const { name, description } = req.body;
                if (!name) {
                    return res.status(400).json({ success: false, message: 'Save name is required' });
                }
                const result = await createSave(name, description);
                res.json(result);
            } catch (error) {
                 console.error('[cloud-saves] Unexpected error in POST /saves:', error);
                 res.status(500).json({ success: false, message: 'Unexpected error while creating save', details: error.message });
            }
        });

        router.post('/saves/load', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const { tagName } = req.body;
                if (!tagName) {
                    return res.status(400).json({ success: false, message: 'Save tag name is required' });
                }
                const result = await loadSave(tagName);
                res.json(result);
            } catch (error) {
                console.error('[cloud-saves] Unexpected error in POST /saves/load:', error);
                res.status(500).json({ success: false, message: 'Unexpected error while loading save', details: error.message });
            }
        });

        router.delete('/saves/:tagName', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const { tagName } = req.params;
                if (!tagName) {
                    return res.status(400).json({ success: false, message: 'Save tag name is required' });
                }
                const result = await deleteSave(tagName);
                res.json(result);
            } catch (error) {
                console.error('[cloud-saves] Unexpected error in DELETE /saves/:tagName:', error);
                res.status(500).json({ success: false, message: 'Unexpected error while deleting save', details: error.message });
            }
        });

        router.put('/saves/:oldTagName', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const { oldTagName } = req.params;
                const { newName, description } = req.body;
                if (!oldTagName || !newName) {
                    return res.status(400).json({ success: false, message: 'Old save tag name and new name are required' });
                }
                const result = await renameSave(oldTagName, newName, description);
                res.json(result);
            } catch (error) {
                console.error('[cloud-saves] Unexpected error in PUT /saves/:oldTagName:', error);
                res.status(500).json({ success: false, message: 'Unexpected error while renaming save', details: error.message });
            }
        });

        router.get('/saves/diff', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const { tag1, tag2 } = req.query;
                if (!tag1 || !tag2) {
                    return res.status(400).json({ success: false, message: 'Two save tag names/references are required' });
                }
                const result = await getSaveDiff(tag1, tag2);
                res.json(result);
            } catch (error) {
                console.error('[cloud-saves] Unexpected error in GET /saves/diff:', error);
                res.status(500).json({ success: false, message: 'Unexpected error while getting save diff', details: error.message });
            }
        });

        router.post('/stash/apply', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const result = await applyTempStash();
                res.json(result);
            } catch (error) {
                 console.error('[cloud-saves] Unexpected error in POST /stash/apply:', error);
                res.status(500).json({ success: false, message: 'Unexpected error while applying temporary stash', details: error.message });
            }
        });

        router.post('/stash/discard', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            try {
                const result = await discardTempStash();
                res.json(result);
            } catch (error) {
                 console.error('[cloud-saves] Unexpected error in POST /stash/discard:', error);
                res.status(500).json({ success: false, message: 'Unexpected error while discarding temporary stash', details: error.message });
            }
        });

        router.post('/saves/:tagName/overwrite', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            currentOperation = 'overwrite_save';
            const { tagName } = req.params;
            let git;
            try {
                const config = await readConfig();
                if (!config.is_authorized) {
                    return res.status(401).json({ success: false, message: 'Not authorized. Please connect repository first.' });
                }
                console.log(`[cloud-saves] Preparing to overwrite save: ${tagName}`);
                git = await getGitInstance();
                const branchToUse = config.branch || DEFAULT_BRANCH;

                let originalDescription = `Overwrite of ${tagName}`;
                try {
                     const tagInfoRaw = await git.raw('tag', '-n1', '-l', tagName, '--format=%(contents)');
                     if (tagInfoRaw) {
                         originalDescription = tagInfoRaw.trim().split('\n')[0];
                     }
                } catch (tagInfoError) { /* Ignore */ }

                await git.add('.');
                const status = await git.status();
                const hasChanges = !status.isClean();
                let newCommitHash;

                if (hasChanges) {
                    const commitMessage = `Overwrite save: ${tagName}`;
                    console.log(`[cloud-saves] Creating overwrite commit: "${commitMessage}"`);
                    try {
                        const commitResult = await git.commit(commitMessage);
                        newCommitHash = commitResult.commit;
                        console.log(`[cloud-saves] New overwrite commit hash: ${newCommitHash}`);
                        try {
                            await git.push('origin', branchToUse);
                        } catch (pushCommitError) {
                            console.warn(`[cloud-saves] Failed to push overwrite commit to branch ${branchToUse}:`, pushCommitError.message);
                        }
                    } catch (commitError) {
                         if (commitError.message.includes('nothing to commit')) {
                             console.log('[cloud-saves] No actual changes to commit during overwrite, using current HEAD');
                             newCommitHash = await git.revparse('HEAD');
                         } else {
                             throw commitError;
                         }
                    }
                } else {
                    console.log('[cloud-saves] No actual changes to commit during overwrite, using current HEAD');
                    newCommitHash = await git.revparse('HEAD');
                }

                 if (!newCommitHash) throw new Error('Unable to determine commit hash for overwrite');

                try { await git.tag(['-d', tagName]); } catch(e) {/*ignore*/}
                try {
                    await git.push(['origin', `:refs/tags/${tagName}`]);
                } catch (delRemoteErr) {
                     if (!delRemoteErr.message.includes('remote ref does not exist')) {
                          console.warn(`[cloud-saves] Problem deleting remote old tag ${tagName}:`, delRemoteErr.message);
                     }
                }

                const tagMessage = originalDescription;
                const nowTimestampOverwrite = new Date().toISOString();
                const fullTagMessageOverwrite = `${tagMessage}\nLast Updated: ${nowTimestampOverwrite}`;
                await git.addAnnotatedTag(tagName, fullTagMessageOverwrite, newCommitHash);

                try {
                    await git.push('origin', tagName);
                } catch (pushTagError) {
                     await git.tag(['-d', tagName]);
                     throw pushTagError;
                }

                const saveNameMatch = tagName.match(/^save_\d+_(.+)$/);
                let saveName = tagName;
                if (saveNameMatch) { try { saveName = Buffer.from(saveNameMatch[1], 'base64url').toString('utf8'); } catch (e) {/*ignore*/} }
                if (config.last_save && config.last_save.tag === tagName) {
                    config.last_save = { name: saveName, tag: tagName, timestamp: nowTimestampOverwrite, description: originalDescription };
                    await saveConfig(config);
                }

                res.json({ success: true, message: 'Save overwritten successfully' });

            } catch (error) {
                console.error(`[cloud-saves] Failed to overwrite save ${tagName}:`, error);
                res.status(500).json(handleGitError(error, `Overwrite save ${tagName}`));
            } finally {
                currentOperation = null;
            }
        });

        router.post('/initialize', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            currentOperation = 'initialize_repo';
            try {
                console.log('[cloud-saves] Received force initialize repository request (selective)...');
                const config = await readConfig();

                const gitDirPath = path.join(DATA_DIR, '.git');
                try {
                    console.log(`[cloud-saves] Force deleting old ${gitDirPath} directory...`);
                    await fs.rm(gitDirPath, { recursive: true, force: true });
                    console.log(`[cloud-saves] Successfully force deleted old ${gitDirPath} directory`);
                } catch (rmError) {
                    console.error(`[cloud-saves] Failed to delete old ${gitDirPath} directory (may not exist or permission issue):`, rmError);
                }

                const initResult = await initGitRepo();
                if (!initResult.success) {
                    return res.status(500).json({ success: false, message: `Failed to initialize Git repository: ${initResult.message}`, details: initResult.details });
                }
                console.log('[cloud-saves] git init successful (forced, selective)');

                 const git = simpleGit(DATA_DIR);

                try {
                     console.log('[cloud-saves] Adding initial commit (forced, selective)...');
                     await git.add('.');
                     const status = await git.status();
                     if (!status.isClean()) {
                         await git.commit('Initial commit after forced re-initialization (characters + chats only)');
                         console.log('[cloud-saves] Initial commit completed (forced)');
                     } else {
                         console.log('[cloud-saves] No changes in data directory, skipping initial commit (forced)');
                     }
                 } catch (initialCommitError) {
                      if (!initialCommitError.message.includes('nothing to commit')) {
                           console.error('[cloud-saves] Error during initial commit (forced):', initialCommitError);
                      }
                 }

                if (config.repo_url) {
                    console.log(`[cloud-saves] Configuring remote repository (forced): ${config.repo_url}`);
                    let authUrl = config.repo_url;
                     if (config.github_token && authUrl.startsWith('https://') && !authUrl.includes('@')) {
                         authUrl = config.repo_url.replace('https://', `https://x-access-token:${config.github_token}@`);
                     }
                     try {
                          try { await git.removeRemote('origin'); } catch(e) {/*ignore*/}
                          await git.addRemote('origin', authUrl);
                          console.log('[cloud-saves] Remote repository configured successfully (forced)');
                     } catch (remoteError) {
                          console.error('[cloud-saves] Failed to configure remote repository (forced):', remoteError);
                          return res.json({
                              success: true,
                              message: 'Repository initialized successfully, but failed to configure remote. Check repository URL or configure manually later.',
                              warning: true,
                              details: remoteError.message
                          });
                     }
                } else {
                    console.log('[cloud-saves] No repository URL configured, skipping remote configuration (forced)');
                }

                res.json({ success: true, message: 'Repository force initialized successfully (characters + chats only)' + (config.repo_url ? ' and remote configured' : '') });

            } catch (error) {
                console.error('[cloud-saves] Error during force initialize repository:', error);
                res.status(500).json(handleGitError(error, 'Force initialize repository'));
            } finally {
                currentOperation = null;
            }
        });

        router.post('/update/check-and-pull', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `Operation in progress: ${currentOperation}` });
            }
            currentOperation = 'check_update';
            const pluginDir = __dirname;
             const targetRemoteUrl = 'https://github.com/fuwei99/cloud-saves.git';
             const targetBranch = 'main';
             let git;

            try {
                console.log('[cloud-saves] Starting plugin update check...');
                 git = simpleGit(pluginDir);

                const isRepo = await git.checkIsRepo();
                if (!isRepo) {
                    console.warn('[cloud-saves] Plugin directory is not a valid Git repository.');
                    return res.json({ success: true, status: 'not_git_repo', message: 'Cannot auto-update: plugin does not appear to be installed via Git.' });
                }

                const remotes = await git.getRemotes(true);
                const origin = remotes.find(r => r.name === 'origin');
                if (!origin) {
                     return res.json({ success: false, status: 'no_remote', message: 'Cannot update: plugin repository has no remote named "origin".' });
                }

                const localRemoteUrl = origin.refs.push;
                const targetRemoteWithoutGit = targetRemoteUrl.replace('.git', '');
                if (localRemoteUrl !== targetRemoteUrl && localRemoteUrl !== targetRemoteWithoutGit) {
                    console.warn(`[cloud-saves] Plugin repository remote (${localRemoteUrl}) does not match target (${targetRemoteUrl}).`);
                    return res.json({
                        success: false,
                        status: 'wrong_remote',
                        message: `Cannot update: plugin remote (${localRemoteUrl}) does not match expected (${targetRemoteUrl}). Make sure the plugin was cloned from the official address.`
                    });
                }

                 console.log('[cloud-saves] Fetching updates from origin...');
                 await git.fetch('origin', targetBranch);

                 const localHash = await git.revparse('HEAD');
                 const remoteHash = await git.revparse(`origin/${targetBranch}`);

                console.log(`[cloud-saves] Local version: ${localHash}`);
                console.log(`[cloud-saves] Remote version (origin/${targetBranch}): ${remoteHash}`);

                if (localHash === remoteHash) {
                    console.log('[cloud-saves] Already up to date.');
                    return res.json({ success: true, status: 'latest', message: 'Already up to date.' });
                }

                 const status = await git.status();
                 if (!status.isClean()) {
                     console.warn('[cloud-saves] Local modifications detected, cannot auto-pull updates.');
                     return res.json({
                         success: false,
                         status: 'local_changes',
                         message: 'Cannot update: local modifications detected in plugin files. Please stash or commit your changes first, or run git pull manually.'
                     });
                 }

                console.log('[cloud-saves] New version detected, attempting git pull...');
                const pullSummary = await git.pull('origin', targetBranch);

                 if (pullSummary.files && pullSummary.files.length > 0 || pullSummary.summary.changes > 0) {
                      console.log('[cloud-saves] git pull successful!', pullSummary.summary);
                      return res.json({ success: true, status: 'updated', message: 'Plugin updated successfully! Please restart SillyTavern service to apply changes.' });
                 } else if (pullSummary.summary.alreadyUpdated) {
                      console.log('[cloud-saves] Pull reports already up to date (state may have updated after fetch)');
                       return res.json({ success: true, status: 'latest', message: 'Already up to date.' });
                 }
                 else {
                      console.error('[cloud-saves] git pull completed but appears not to have updated successfully or status unknown.', pullSummary);
                      return res.json({
                           success: false,
                           status: 'pull_failed',
                           message: `Update appears to have failed or status unknown. Check console logs or try running git pull manually.`
                      });
                 }

            } catch (error) {
                console.error('[cloud-saves] Error checking or performing plugin update:', error);
                res.status(500).json({ success: false, status:'error', message: `Internal error while checking for updates: ${error.message}` });
            } finally {
                currentOperation = null;
            }
        });

        setupBackendAutoSaveTimer();

    } catch (error) {
        console.error('[cloud-saves] Plugin initialization failed:', error);
    }
}

const plugin = {
    info: info,
    init: init,
};

module.exports = plugin;
