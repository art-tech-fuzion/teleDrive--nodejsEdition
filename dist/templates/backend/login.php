<?php
/**
 * TeleDrive Admin Login View Template
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
    <title>TeleDrive | Admin Authentication</title>
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg?v=<?= file_exists(__DIR__ . '/../../assets/favicon.svg') ? filemtime(__DIR__ . '/../../assets/favicon.svg') : '1.0' ?>">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="assets/global.css?v=<?= file_exists(__DIR__ . '/../../assets/global.css') ? filemtime(__DIR__ . '/../../assets/global.css') : '1.0' ?>">
    <link rel="stylesheet" href="assets/backend/login.css?v=<?= file_exists(__DIR__ . '/../../assets/backend/login.css') ? filemtime(__DIR__ . '/../../assets/backend/login.css') : '1.0' ?>">
</head>
<body class="td-login-body">
    <div class="td-login-wrapper">
        <div class="td-login-card">
            <div class="td-login-header">
                <div class="td-login-logo">
                    <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 2L11 13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <h1 class="td-login-title">TeleDrive</h1>
                <p class="td-login-subtitle">Cloud File Manager Powered by Telegram</p>
            </div>

            <form id="td-login-form" class="td-login-form" autocomplete="off">
                <div class="td-form-group">
                    <label for="td-username" class="td-form-label">Username</label>
                    <div class="td-input-wrapper">
                        <input type="text" id="td-username" name="username" class="td-form-input" placeholder="admin" required autofocus>
                    </div>
                </div>

                <div class="td-form-group">
                    <label for="td-password" class="td-form-label">Password</label>
                    <div class="td-input-wrapper">
                        <input type="password" id="td-password" name="password" class="td-form-input" placeholder="••••••••" required>
                    </div>
                </div>

                <button type="submit" id="td-login-btn" class="td-btn-primary">
                    <span class="td-btn-text">Sign In</span>
                    <div class="td-spinner" style="display: none;"></div>
                </button>
            </form>

            <div class="td-login-footer">
                <span>Zero-Database Architecture &bull; Pure PHP 8.x</span>
            </div>
        </div>
    </div>

    <script src="assets/global.js?v=<?= file_exists(__DIR__ . '/../../assets/global.js') ? filemtime(__DIR__ . '/../../assets/global.js') : '1.0' ?>"></script>
    <script src="assets/backend/login.js?v=<?= file_exists(__DIR__ . '/../../assets/backend/login.js') ? filemtime(__DIR__ . '/../../assets/backend/login.js') : '1.0' ?>"></script>
</body>
</html>
