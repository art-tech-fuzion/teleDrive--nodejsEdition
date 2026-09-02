<?php
/**
 * TeleDrive Dashboard Frontend View Template
 */
if (!defined('TELEDRIVE_INIT')) {
    exit('Direct access not permitted');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TeleDrive | Telegram Cloud Drive</title>
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg?v=<?= file_exists(__DIR__ . '/../../assets/favicon.svg') ? filemtime(__DIR__ . '/../../assets/favicon.svg') : '1.0' ?>">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="assets/global.css?v=<?= file_exists(__DIR__ . '/../../assets/global.css') ? filemtime(__DIR__ . '/../../assets/global.css') : '1.0' ?>">
    <link rel="stylesheet" href="assets/frontend/app.css?v=<?= file_exists(__DIR__ . '/../../assets/frontend/app.css') ? filemtime(__DIR__ . '/../../assets/frontend/app.css') : '1.0' ?>">
    <!-- CSRF token for all authenticated POST requests -->
    <meta name="csrf-token" content="<?= htmlspecialchars(Auth::getCsrfToken(), ENT_QUOTES, 'UTF-8') ?>">

</head>
<body class="td-app-body">
    <!-- Mobile Sidebar Backdrop Overlay -->
    <div class="td-sidebar-backdrop" id="td-sidebar-backdrop"></div>

    <div class="td-layout">
        <!-- Sidebar Navigation -->
        <aside class="td-sidebar" id="td-sidebar">
            <div class="td-brand">
                <div class="td-brand-icon">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 2L11 13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <div class="td-brand-name">TeleDrive</div>
                <button id="td-sidebar-close" class="td-sidebar-close-btn" aria-label="Close Navigation Menu" title="Close Menu">✕</button>
            </div>

            <div class="td-sidebar-actions">
                <button id="td-btn-upload-trigger" class="td-btn-upload">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 5v14M5 12h14" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span>New Upload</span>
                </button>
                <input type="file" id="td-file-input" multiple style="display: none;">

                <button id="td-btn-new-folder" class="td-btn-sidebar-secondary">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        <line x1="12" y1="11" x2="12" y2="17"/>
                        <line x1="9" y1="14" x2="15" y2="14"/>
                    </svg>
                    <span>New Folder</span>
                </button>
            </div>

            <nav class="td-nav">
                <a href="#root" class="td-nav-item active" data-folder-id="root">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                        <polyline points="9 22 9 12 15 12 15 22"/>
                    </svg>
                    <span>All Files</span>
                </a>
            </nav>

            <div class="td-sidebar-storage">
                <div class="td-storage-info">
                    <div class="td-storage-title">Telegram Cloud</div>
                    <div class="td-storage-desc">Unlimited Storage Engine</div>
                </div>
                <div class="td-storage-bar">
                    <div class="td-storage-bar-progress" style="width: 100%;"></div>
                </div>
            </div>

            <div class="td-user-profile">
                <div class="td-avatar">A</div>
                <div class="td-user-info">
                    <div class="td-username"><?= htmlspecialchars($_SESSION['teledrive_user'] ?? 'Admin') ?></div>
                    <div class="td-role">Administrator</div>
                </div>
                <button id="td-btn-logout" class="td-btn-icon-logout" title="Sign Out">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                        <polyline points="16 17 21 12 16 7"/>
                        <line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                </button>
            </div>
        </aside>

        <!-- Main Workspace Area -->
        <main class="td-main">
            <!-- Top App Bar -->
            <header class="td-header">
                <button id="td-mobile-menu-btn" class="td-btn-icon td-mobile-menu-btn" title="Open Navigation Menu" aria-label="Open Navigation Menu">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="3" y1="12" x2="21" y2="12"></line>
                        <line x1="3" y1="6" x2="21" y2="6"></line>
                        <line x1="3" y1="18" x2="21" y2="18"></line>
                    </svg>
                </button>

                <div class="td-search-box">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input type="text" id="td-search-input" placeholder="Search files and folders in drive...">
                </div>

                <div class="td-header-actions">
                    <button id="td-btn-refresh" class="td-btn-icon" title="Refresh">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M23 4v6h-6"/>
                            <path d="M1 20v-6h6"/>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                        </svg>
                    </button>
                    <div class="td-view-toggle">
                        <button id="td-btn-view-grid" class="td-btn-view active" title="Grid View">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="7" height="7"/>
                                <rect x="14" y="3" width="7" height="7"/>
                                <rect x="14" y="14" width="7" height="7"/>
                                <rect x="3" y="14" width="7" height="7"/>
                            </svg>
                        </button>
                        <button id="td-btn-view-list" class="td-btn-view" title="List View">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="8" y1="6" x2="21" y2="6"/>
                                <line x1="8" y1="12" x2="21" y2="12"/>
                                <line x1="8" y1="18" x2="21" y2="18"/>
                                <line x1="3" y1="6" x2="3.01" y2="6"/>
                                <line x1="3" y1="12" x2="3.01" y2="12"/>
                                <line x1="3" y1="18" x2="3.01" y2="18"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </header>

            <!-- Navigation & Breadcrumb Bar -->
            <div class="td-toolbar">
                <div class="td-breadcrumbs" id="td-breadcrumbs">
                    <span class="td-breadcrumb-item active" data-id="root">My Drive</span>
                </div>
                <div class="td-toolbar-right">
                    <div class="td-item-counter" id="td-item-counter">0 items</div>
                </div>
            </div>

            <!-- Bulk Selection Bar -->
            <div class="td-bulk-bar" id="td-bulk-bar" style="display: none;">
                <div class="td-bulk-left">
                    <label class="td-checkbox-wrapper" title="Select All Items">
                        <input type="checkbox" id="td-select-all" class="td-custom-checkbox">
                        <span class="td-custom-checkmark"></span>
                    </label>
                    <span class="td-bulk-counter" id="td-bulk-counter">0 selected</span>
                </div>
                <div class="td-bulk-right">
                    <button id="td-btn-bulk-delete" class="td-btn-sm td-btn-danger" title="Delete selected items">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        Delete Selected
                    </button>
                    <button id="td-btn-bulk-clear" class="td-btn-icon-sm" title="Clear selection">✕</button>
                </div>
            </div>

            <!-- Content Area (Grid & List Views) with Drag and Drop Overlay -->
            <div class="td-dropzone-container" id="td-dropzone-container">
                <div class="td-drag-overlay" id="td-drag-overlay">
                    <div class="td-drag-card">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="17 8 12 3 7 8"/>
                            <line x1="12" y1="3" x2="12" y2="15"/>
                        </svg>
                        <h3>Drop files here to upload</h3>
                        <p>Directly to your Telegram Cloud</p>
                    </div>
                </div>

                <!-- Empty State -->
                <div class="td-empty-state" id="td-empty-state" style="display: none;">
                    <div class="td-empty-icon">📁</div>
                    <h3>This folder is empty</h3>
                    <p>Drag and drop files here or click "New Upload" to get started</p>
                </div>

                <!-- Items Grid View -->
                <div class="td-grid-view" id="td-grid-view"></div>

                <!-- Items List View -->
                <div class="td-list-view" id="td-list-view" style="display: none;">
                    <table class="td-table">
                        <thead>
                            <tr>
                                <th style="width: 40px; text-align: center;">
                                    <label class="td-checkbox-wrapper" title="Select All">
                                        <input type="checkbox" id="td-select-all-list" class="td-custom-checkbox">
                                        <span class="td-custom-checkmark"></span>
                                    </label>
                                </th>
                                <th>Name</th>
                                <th>Size</th>
                                <th>Modified</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody id="td-table-body"></tbody>
                    </table>
                </div>
            </div>

            <!-- Active Uploads Floating Queue -->
            <div class="td-upload-queue" id="td-upload-queue" style="display: none;">
                <div class="td-queue-header">
                    <span id="td-queue-title">Uploading 1 file...</span>
                    <button id="td-queue-close" class="td-btn-icon-sm">✕</button>
                </div>
                <div class="td-queue-items" id="td-queue-items"></div>
            </div>
        </main>
    </div>

    <!-- Preview Modal -->
    <div class="td-preview-modal" id="td-preview-modal" style="display: none;">
        <div class="td-preview-overlay"></div>
        <div class="td-preview-container">
            <div class="td-preview-header">
                <div class="td-preview-filename" id="td-preview-name">File Preview</div>
                <div class="td-preview-actions">
                    <a id="td-preview-download" href="#" class="td-btn-sm td-btn-primary" download>Download</a>
                    <button id="td-preview-close" class="td-btn-icon">✕</button>
                </div>
            </div>
            <div class="td-preview-body" id="td-preview-body"></div>
        </div>
    </div>

    <script src="assets/global.js?v=<?= file_exists(__DIR__ . '/../../assets/global.js') ? filemtime(__DIR__ . '/../../assets/global.js') : '1.0' ?>"></script>
    <script src="assets/frontend/app.js?v=<?= file_exists(__DIR__ . '/../../assets/frontend/app.js') ? filemtime(__DIR__ . '/../../assets/frontend/app.js') : '1.0' ?>"></script>
</body>
</html>
