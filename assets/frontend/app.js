/**
 * TeleDrive Cloud File Manager Application Controller
 * Handles Navigation, Client-Side File Chunking, Previews, CRUD & Drag-Drop.
 */

document.addEventListener("DOMContentLoaded", () => {
  // ---------------------------------------------------------------------------
  // CSRF Helper — reads token from <meta name="csrf-token"> injected by PHP
  // ---------------------------------------------------------------------------
  function getCsrfToken() {
    return (
      document
        .querySelector('meta[name="csrf-token"]')
        ?.getAttribute("content") || ""
    );
  }

  /**
   * Wrapper around fetch() that automatically attaches the CSRF token header
   * for all POST/PUT/DELETE requests, so every call site stays clean.
   */
  function apiFetch(url, options = {}) {
    let cleanUrl = url;
    if (cleanUrl.startsWith('api/index.php')) {
      cleanUrl = '/' + cleanUrl;
    }
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      options.headers = options.headers || {};
      options.headers["X-CSRF-Token"] = getCsrfToken();
    }
    return fetch(cleanUrl, options);
  }

  // ---------------------------------------------------------------------------
  // SVG Icon Builder — returns SVG markup for common action icons
  // ---------------------------------------------------------------------------
  const SVG_ICONS = {
    download: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    move: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>`,
    rename: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    delete: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  };

  function makeActionBtn(type, title) {
    return `<button class="td-action-btn td-action-${type}" title="${title}">${SVG_ICONS[type]}</button>`;
  }

  // ---------------------------------------------------------------------------
  // Application State
  // ---------------------------------------------------------------------------
  const state = {
    currentFolderId: "root",
    folderPath: [{ id: "root", name: "My Drive" }],
    items: [],
    selectedIds: new Set(),
    needsIndexPurge: false,
    viewMode: "grid", // 'grid' | 'list'
    chunkSize: Math.floor(3.5 * 1024 * 1024), // 3.5MB Chunks for optimized speed & low latency
  };

  // DOM Elements
  const gridView = document.getElementById("td-grid-view");
  const listView = document.getElementById("td-list-view");
  const tableBody = document.getElementById("td-table-body");
  const emptyState = document.getElementById("td-empty-state");
  const breadcrumbs = document.getElementById("td-breadcrumbs");
  const itemCounter = document.getElementById("td-item-counter");
  const searchInput = document.getElementById("td-search-input");
  const refreshBtn = document.getElementById("td-btn-refresh");
  const logoutBtn = document.getElementById("td-btn-logout");
  const newFolderBtn = document.getElementById("td-btn-new-folder");
  const uploadTrigger = document.getElementById("td-btn-upload-trigger");
  const fileInput = document.getElementById("td-file-input");
  const dropzone = document.getElementById("td-dropzone-container");
  const dragOverlay = document.getElementById("td-drag-overlay");
  const btnViewGrid = document.getElementById("td-btn-view-grid");
  const btnViewList = document.getElementById("td-btn-view-list");
  const previewModal = document.getElementById("td-preview-modal");
  const previewName = document.getElementById("td-preview-name");
  const previewBody = document.getElementById("td-preview-body");
  const previewDownload = document.getElementById("td-preview-download");
  const previewClose = document.getElementById("td-preview-close");
  const uploadQueue = document.getElementById("td-upload-queue");
  const queueItems = document.getElementById("td-queue-items");
  const queueClose = document.getElementById("td-queue-close");
  const mobileMenuBtn = document.getElementById("td-mobile-menu-btn");
  const sidebarCloseBtn = document.getElementById("td-sidebar-close");
  const sidebarBackdrop = document.getElementById("td-sidebar-backdrop");
  const sidebar = document.getElementById("td-sidebar");

  // Bulk Actions Elements
  const bulkBar = document.getElementById("td-bulk-bar");
  const bulkCounter = document.getElementById("td-bulk-counter");
  const selectAllCheckbox = document.getElementById("td-select-all");
  const selectAllListCheckbox = document.getElementById("td-select-all-list");
  const bulkDeleteBtn = document.getElementById("td-btn-bulk-delete");
  const bulkClearBtn = document.getElementById("td-btn-bulk-clear");

  // Mobile Sidebar Drawer Handlers
  function openMobileSidebar() {
    if (sidebar) sidebar.classList.add("td-sidebar-open");
    if (sidebarBackdrop) sidebarBackdrop.classList.add("active");
  }

  function closeMobileSidebar() {
    if (sidebar) sidebar.classList.remove("td-sidebar-open");
    if (sidebarBackdrop) sidebarBackdrop.classList.remove("active");
  }

  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener("click", openMobileSidebar);
  }
  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener("click", closeMobileSidebar);
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", closeMobileSidebar);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMobileSidebar();
    }
  });

  // 1. Initial Load & Routing
  loadFolder("root");

  // 2. View Mode Toggle
  btnViewGrid.onclick = () => {
    state.viewMode = "grid";
    btnViewGrid.classList.add("active");
    btnViewList.classList.remove("active");
    gridView.style.display = "grid";
    listView.style.display = "none";
  };

  btnViewList.onclick = () => {
    state.viewMode = "list";
    btnViewList.classList.add("active");
    btnViewGrid.classList.remove("active");
    gridView.style.display = "none";
    listView.style.display = "block";
  };

  // 3. Navigation (All Files sidebar button)
  const navAllFiles = document.querySelector(
    '.td-nav-item[data-folder-id="root"]',
  );
  if (navAllFiles) {
    navAllFiles.onclick = (e) => {
      e.preventDefault();
      state.folderPath = [{ id: "root", name: "My Drive" }];
      closeMobileSidebar();
      loadFolder("root");
    };
  }

  // 4. Search & Refresh
  let searchDebounce = null;
  searchInput.oninput = (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      loadFolder(state.currentFolderId, e.target.value.trim());
    }, 300);
  };

  refreshBtn.onclick = () => {
    TeleDrive.toast("Syncing with Telegram Cloud...", "info", 1500);
    loadFolder(state.currentFolderId, "", true);
  };

  // 5. Logout Action
  logoutBtn.onclick = async () => {
    const confirmed = await TeleDrive.confirm({
      title: "Sign Out",
      message: "Are you sure you want to sign out of TeleDrive?",
      confirmText: "Sign Out",
      isDanger: true,
    });
    if (confirmed) {
      await fetch("/api/index.php?action=auth.logout");
      window.location.reload();
    }
  };

  // 5. Load Folder Items with Skeleton Buffer
  async function loadFolder(folderId, search = "", forceRefresh = false) {
    state.currentFolderId = folderId;
    state.selectedIds.clear();
    updateBulkBarUI();

    // Show instant skeleton buffer to prevent empty flash
    renderSkeletonBuffer();
    renderBreadcrumbs();

    try {
      let url = `/api/index.php?action=files.list&parent_id=${encodeURIComponent(folderId)}&search=${encodeURIComponent(search)}`;
      if (forceRefresh) {
        url += "&refresh=1";
      }
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.status === 401) {
        renderItems();
        TeleDrive.toast("Session expired. Please log in again.", "warning");
        setTimeout(() => {
          window.location.href = "/login";
        }, 1200);
        return;
      }
      const rawText = await res.text();
      let data = null;
      try {
        data = JSON.parse(rawText);
      } catch (jsonErr) {
        throw new Error(
          rawText.replace(/<[^>]*>?/gm, "").trim() ||
            "Server returned invalid response",
        );
      }

      if (data && data.success) {
        state.items = data.items || [];
        renderItems();
        if (forceRefresh) {
          TeleDrive.toast("Index synchronized with Telegram.", "success", 2000);
        }
      } else {
        renderItems();
        TeleDrive.toast(
          (data && data.error) || "Failed to load files.",
          "error",
        );
      }
    } catch (err) {
      console.error("Error loading files:", err);
      renderItems(); // Always clear skeleton buffer so screen never freezes
      TeleDrive.toast(`Error loading files: ${err.message || err}`, "error");
    }
  }

  function renderSkeletonBuffer() {
    emptyState.style.display = "none";
    if (state.viewMode === "grid") {
      gridView.style.display = "grid";
      listView.style.display = "none";
      gridView.innerHTML = Array(6)
        .fill(0)
        .map(
          () => `
                <div class="td-skeleton-card td-skeleton-shimmer">
                    <div class="td-skeleton-preview"></div>
                    <div class="td-skeleton-line"></div>
                    <div class="td-skeleton-line-sm"></div>
                </div>
            `,
        )
        .join("");
    }
  }

  // 6. Render Breadcrumbs
  function renderBreadcrumbs() {
    breadcrumbs.innerHTML = "";
    state.folderPath.forEach((crumb, idx) => {
      const isLast = idx === state.folderPath.length - 1;
      const span = document.createElement("span");
      span.className = `td-breadcrumb-item ${isLast ? "active" : ""}`;
      span.textContent = crumb.name;
      span.onclick = () => {
        if (!isLast) {
          state.folderPath = state.folderPath.slice(0, idx + 1);
          loadFolder(crumb.id);
        }
      };
      breadcrumbs.appendChild(span);

      if (!isLast) {
        const sep = document.createElement("span");
        sep.className = "td-breadcrumb-separator";
        sep.textContent = "/";
        breadcrumbs.appendChild(sep);
      }
    });
  }

  // 7. Bulk Actions Bar UI Synchronizer
  function updateBulkBarUI() {
    const count = state.selectedIds.size;
    const total = state.items.length;

    if (bulkBar) {
      bulkBar.style.display = count > 0 ? "flex" : "none";
    }
    if (bulkCounter) {
      bulkCounter.textContent = `${count} selected`;
    }

    const isAllSelected = total > 0 && count === total;
    const isIndeterminate = count > 0 && count < total;

    if (selectAllCheckbox) {
      selectAllCheckbox.checked = isAllSelected;
      selectAllCheckbox.indeterminate = isIndeterminate;
    }
    if (selectAllListCheckbox) {
      selectAllListCheckbox.checked = isAllSelected;
      selectAllListCheckbox.indeterminate = isIndeterminate;
    }

    document.querySelectorAll(".td-grid-card").forEach((card) => {
      const id = card.dataset.itemId;
      const isSelected = state.selectedIds.has(id);
      card.classList.toggle("selected", isSelected);
      const cb = card.querySelector(".td-item-checkbox");
      if (cb) cb.checked = isSelected;
    });

    document.querySelectorAll(".td-table-row").forEach((row) => {
      const id = row.dataset.itemId;
      const isSelected = state.selectedIds.has(id);
      row.classList.toggle("selected", isSelected);
      const cb = row.querySelector(".td-item-checkbox");
      if (cb) cb.checked = isSelected;
    });
  }

  // 8. Render Items (Grid & List)
  function renderItems() {
    itemCounter.textContent = `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;

    if (state.items.length === 0) {
      emptyState.style.display = "flex";
      gridView.style.display = "none";
      listView.style.display = "none";
      updateBulkBarUI();
      return;
    }

    emptyState.style.display = "none";
    if (state.viewMode === "grid") {
      gridView.style.display = "grid";
      listView.style.display = "none";
    } else {
      gridView.style.display = "none";
      listView.style.display = "block";
    }

    // Render Grid
    gridView.innerHTML = "";
    state.items.forEach((item) => {
      const isSelected = state.selectedIds.has(item.id);
      const card = document.createElement("div");
      card.className = `td-grid-card ${isSelected ? "selected" : ""}`;
      card.dataset.itemId = item.id;
      const iconData = getFileIcon(item);

      card.innerHTML = `
                <div class="td-grid-card-select">
                    <label class="td-checkbox-wrapper" title="Select item">
                        <input type="checkbox" class="td-custom-checkbox td-item-checkbox" ${isSelected ? "checked" : ""}>
                        <span class="td-custom-checkmark"></span>
                    </label>
                </div>
                <div class="td-grid-card-preview ${iconData.colorClass}">
                    <span class="td-grid-card-icon">${iconData.icon}</span>
                </div>
                <div class="td-grid-card-info">
                    <div class="td-grid-card-name" title="${item.name}">${escapeHtml(item.name)}</div>
                    <div class="td-grid-card-meta">
                        <span>${item.type === "folder" ? "Folder" : formatBytes(item.size)}</span>
                        <span>${formatDate(item.updated_at || item.created_at)}</span>
                    </div>
                </div>
                <div class="td-grid-card-actions">
                    ${item.type === "file" ? makeActionBtn("download", "Download") : ""}
                    ${makeActionBtn("move", "Move")}
                    ${makeActionBtn("rename", "Rename")}
                    ${makeActionBtn("delete", "Delete")}
                </div>
            `;

      const itemCheckbox = card.querySelector(".td-item-checkbox");
      itemCheckbox.onchange = (e) => {
        e.stopPropagation();
        if (itemCheckbox.checked) {
          state.selectedIds.add(item.id);
        } else {
          state.selectedIds.delete(item.id);
        }
        updateBulkBarUI();
      };

      // Open Folder or Preview
      card.onclick = (e) => {
        if (
          e.target.closest(".td-grid-card-actions") ||
          e.target.closest(".td-grid-card-select")
        )
          return;
        handleItemClick(item);
      };

      if (item.type === "file") {
        card.querySelector(".td-action-download").onclick = (e) => {
          e.stopPropagation();
          startControlledDownload(item);
        };
      }

      card.querySelector(".td-action-move").onclick = (e) => {
        e.stopPropagation();
        handleMove(item);
      };

      card.querySelector(".td-action-rename").onclick = (e) => {
        e.stopPropagation();
        handleRename(item);
      };

      card.querySelector(".td-action-delete").onclick = (e) => {
        e.stopPropagation();
        handleDelete(item);
      };

      gridView.appendChild(card);
    });

    // Render List Table
    tableBody.innerHTML = "";
    state.items.forEach((item) => {
      const isSelected = state.selectedIds.has(item.id);
      const tr = document.createElement("tr");
      tr.className = `td-table-row ${isSelected ? "selected" : ""}`;
      tr.dataset.itemId = item.id;
      const iconData = getFileIcon(item);

      tr.innerHTML = `
                <td class="td-table-checkbox-cell">
                    <label class="td-checkbox-wrapper" title="Select item">
                        <input type="checkbox" class="td-custom-checkbox td-item-checkbox" ${isSelected ? "checked" : ""}>
                        <span class="td-custom-checkmark"></span>
                    </label>
                </td>
                <td>
                    <div class="td-table-name-cell">
                        <span class="td-file-icon">${iconData.icon}</span>
                        <span title="${item.name}">${escapeHtml(item.name)}</span>
                    </div>
                </td>
                <td>${item.type === "folder" ? "—" : formatBytes(item.size)}</td>
                <td>${formatDate(item.updated_at || item.created_at)}</td>
                <td>
                    <div class="td-table-actions">
                        ${item.type === "file" ? makeActionBtn("download", "Download") : ""}
                        ${makeActionBtn("move", "Move")}
                        ${makeActionBtn("rename", "Rename")}
                        ${makeActionBtn("delete", "Delete")}
                    </div>
                </td>
            `;

      const itemCheckbox = tr.querySelector(".td-item-checkbox");
      itemCheckbox.onchange = (e) => {
        e.stopPropagation();
        if (itemCheckbox.checked) {
          state.selectedIds.add(item.id);
        } else {
          state.selectedIds.delete(item.id);
        }
        updateBulkBarUI();
      };

      tr.onclick = (e) => {
        if (
          e.target.closest(".td-action-btn") ||
          e.target.closest(".td-table-checkbox-cell")
        )
          return;
        handleItemClick(item);
      };

      if (item.type === "file") {
        tr.querySelector(".td-action-download").onclick = (e) => {
          e.stopPropagation();
          startControlledDownload(item);
        };
      }

      tr.querySelector(".td-action-move").onclick = (e) => {
        e.stopPropagation();
        handleMove(item);
      };

      tr.querySelector(".td-action-rename").onclick = (e) => {
        e.stopPropagation();
        handleRename(item);
      };

      tr.querySelector(".td-action-delete").onclick = (e) => {
        e.stopPropagation();
        handleDelete(item);
      };

      tableBody.appendChild(tr);
    });

    updateBulkBarUI();
  }

  // 8. Item Interaction: Open or Preview
  function handleItemClick(item) {
    if (item.type === "folder") {
      state.folderPath.push({ id: item.id, name: item.name });
      loadFolder(item.id);
    } else {
      openPreview(item);
    }
  }

  // 9. Preview Modal Handler
  function openPreview(item) {
    previewName.textContent = item.name;
    const previewUrl = `/api/index.php?action=files.preview&id=${encodeURIComponent(item.id)}`;

    previewDownload.onclick = (e) => {
      e.preventDefault();
      startControlledDownload(item);
    };

    previewBody.innerHTML = "";
    const mime = item.mime_type || "";

    if (mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = previewUrl;
      previewBody.appendChild(img);
    } else if (mime.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = previewUrl;
      video.controls = true;
      video.autoplay = true;
      previewBody.appendChild(video);
    } else if (mime.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.src = previewUrl;
      audio.controls = true;
      previewBody.appendChild(audio);
    } else if (mime === "application/pdf") {
      const iframe = document.createElement("iframe");
      iframe.src = previewUrl;
      previewBody.appendChild(iframe);
    } else {
      previewBody.innerHTML = `
                <div style="color:var(--text-secondary); text-align:center;">
                    <div style="font-size:48px; margin-bottom:12px;">📄</div>
                    <p>No inline preview available for this file type.</p>
                    <button class="td-btn-primary td-btn-sm" style="margin-top:12px;" id="td-preview-alt-download">Download File</button>
                </div>
            `;
      const altBtn = previewBody.querySelector("#td-preview-alt-download");
      if (altBtn) {
        altBtn.onclick = () => startControlledDownload(item);
      }
    }

    previewModal.style.display = "flex";
  }

  previewClose.onclick = () => {
    previewModal.style.display = "none";
    previewBody.innerHTML = "";
  };

  // 10. Folder Creation with custom modal dialog
  newFolderBtn.onclick = async () => {
    const folderName = await TeleDrive.prompt({
      title: "Create New Folder",
      message: "Enter a name for the new folder:",
      placeholder: "Folder name (e.g. Documents, Projects)",
      confirmText: "Create Folder",
      defaultValue: "",
    });

    if (!folderName || !folderName.trim()) return;

    const toastCtrl = TeleDrive.toast(
      `Creating folder "${folderName.trim()}" in Telegram...`,
      "loading",
      0,
    );

    try {
      const formData = new FormData();
      formData.append("action", "folder.create");
      formData.append("name", folderName.trim());
      formData.append("parent_id", state.currentFolderId);

      const res = await apiFetch("api/index.php", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success && data.folder) {
        state.items.unshift(data.folder);
        renderItems();
        toastCtrl.update(
          `Folder "${data.folder.name}" created successfully.`,
          "success",
          2500,
        );

        if (data.needs_purge) {
          state.needsIndexPurge = true;
          triggerIndexPurge();
        }
      } else {
        toastCtrl.update(
          data.error || "Failed to create folder.",
          "error",
          4000,
        );
      }
    } catch (err) {
      console.error("Error creating folder:", err);
      toastCtrl.update(
        `Error creating folder: ${err.message || err}`,
        "error",
        4000,
      );
    }
  };

  // 11. Rename Item with Optimistic UI & Loading Toast
  async function handleRename(item) {
    const newName = await TeleDrive.prompt({
      title: `Rename ${item.type === "folder" ? "Folder" : "File"}`,
      message: `Enter a new name for "${item.name}":`,
      defaultValue: item.name,
      placeholder: "New name",
      confirmText: "Rename",
    });

    if (!newName || !newName.trim() || newName.trim() === item.name) return;

    const oldName = item.name;
    const cleanNewName = newName.trim();

    // 1. Optimistic UI update in DOM and state
    item.name = cleanNewName;
    const matchingElms = document.querySelectorAll(
      `[data-item-id="${item.id}"]`,
    );
    matchingElms.forEach((el) => {
      const nameEl = el.querySelector(
        ".td-grid-card-name, .td-table-name-cell span[title]",
      );
      if (nameEl) {
        nameEl.textContent = cleanNewName;
        nameEl.title = cleanNewName;
      }
    });

    const toastCtrl = TeleDrive.toast(
      `Renaming to "${cleanNewName}"...`,
      "loading",
      0,
    );

    try {
      const formData = new FormData();
      formData.append("action", "items.rename");
      formData.append("id", item.id);
      formData.append("name", cleanNewName);

      const res = await apiFetch("api/index.php", {
        method: "POST",
        body: formData,
      });
      const rawText = await res.text();
      let data = null;
      try {
        data = JSON.parse(rawText);
      } catch (jsonErr) {
        throw new Error(
          rawText.replace(/<[^>]*>?/gm, "").trim() ||
            "Server returned invalid response",
        );
      }

      if (data && data.success) {
        toastCtrl.update(
          `Renamed to "${cleanNewName}" successfully.`,
          "success",
          2500,
        );
      } else {
        // Revert on server error
        item.name = oldName;
        matchingElms.forEach((el) => {
          const nameEl = el.querySelector(
            ".td-grid-card-name, .td-table-name-cell span[title]",
          );
          if (nameEl) {
            nameEl.textContent = oldName;
            nameEl.title = oldName;
          }
        });
        toastCtrl.update(
          (data && data.error) || "Failed to rename item.",
          "error",
          4000,
        );
      }
    } catch (err) {
      console.error("Error renaming item:", err);
      item.name = oldName;
      matchingElms.forEach((el) => {
        const nameEl = el.querySelector(
          ".td-grid-card-name, .td-table-name-cell span[title]",
        );
        if (nameEl) {
          nameEl.textContent = oldName;
          nameEl.title = oldName;
        }
      });
      toastCtrl.update(
        `Error renaming item: ${err.message || err}`,
        "error",
        4000,
      );
    }
  }

  // 12. Move Item to Destination Folder Modal with Instant Optimistic Transition
  async function handleMove(item) {
    // Fetch all available folders
    try {
      const res = await fetch("/api/index.php?action=folders.list");
      const data = await res.json();
      const allFolders = (data.folders || []).filter((f) => f.id !== item.id);

      const overlay = document.createElement("div");
      overlay.className = "td-modal-overlay";
      overlay.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                background: var(--bg-overlay, rgba(11, 15, 23, 0.8));
                backdrop-filter: blur(6px);
                display: flex; align-items: center; justify-content: center;
                z-index: 9998; opacity: 0;
                transition: opacity 0.2s ease;
            `;

      const modalBox = document.createElement("div");
      modalBox.style.cssText = `
                background: var(--bg-surface, #1e293b);
                border: 1px solid var(--border-color, rgba(255,255,255,0.1));
                border-radius: var(--radius-lg, 12px);
                padding: 24px; width: 90%; max-width: 440px;
                box-shadow: var(--shadow-xl, 0 20px 45px rgba(0,0,0,0.5));
                transform: scale(0.95);
                transition: transform 0.2s ease;
            `;

      modalBox.innerHTML = `
                <h3 style="font-size: var(--font-size-lg, 18px); font-weight: 600; margin-bottom: 6px; color: var(--text-main);">Move "${escapeHtml(item.name)}"</h3>
                <p style="font-size: var(--font-size-sm, 14px); color: var(--text-secondary); margin-bottom: 16px;">Select destination folder:</p>
                <div style="margin-bottom: 20px;">
                    <select id="td-move-dest-select" style="
                        width: 100%; padding: 10px 14px;
                        background: var(--bg-body, #0b0f17);
                        border: 1px solid var(--border-color, rgba(255,255,255,0.15));
                        border-radius: var(--radius-md, 8px);
                        color: var(--text-main, #f8fafc);
                        font-size: var(--font-size-sm, 14px);
                        outline: none;
                    ">
                        <option value="root" ${item.parent_id === "root" ? "disabled" : ""}>📁 / (Root - My Drive)</option>
                        ${allFolders
                          .map(
                            (f) => `
                            <option value="${f.id}" ${item.parent_id === f.id ? "disabled" : ""}>
                                📁 ${escapeHtml(f.name)} ${item.parent_id === f.id ? "(Current Folder)" : ""}
                            </option>
                        `,
                          )
                          .join("")}
                    </select>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 10px;">
                    <button id="td-move-cancel" style="
                        background: transparent;
                        border: 1px solid var(--border-color);
                        color: var(--text-main);
                        padding: 8px 16px; border-radius: var(--radius-sm);
                        cursor: pointer; font-size: 13px; font-weight: 500;
                    ">Cancel</button>
                    <button id="td-move-confirm" style="
                        background: var(--color-primary, #3b82f6);
                        border: none; color: #ffffff;
                        padding: 8px 20px; border-radius: var(--radius-sm);
                        cursor: pointer; font-size: 13px; font-weight: 600;
                    ">Move Here</button>
                </div>
            `;

      overlay.appendChild(modalBox);
      document.body.appendChild(overlay);

      requestAnimationFrame(() => {
        overlay.style.opacity = "1";
        modalBox.style.transform = "scale(1)";
      });

      const cleanup = () => {
        overlay.style.opacity = "0";
        modalBox.style.transform = "scale(0.95)";
        setTimeout(() => overlay.remove(), 200);
      };

      modalBox.querySelector("#td-move-cancel").onclick = cleanup;

      modalBox.querySelector("#td-move-confirm").onclick = async () => {
        const select = modalBox.querySelector("#td-move-dest-select");
        const destId = select.value;
        cleanup();

        // Optimistic: animate item out immediately
        const matchingElms = document.querySelectorAll(
          `[data-item-id="${item.id}"]`,
        );
        matchingElms.forEach((el) => el.classList.add("td-item-leaving"));

        const toastCtrl = TeleDrive.toast(
          `Moving "${item.name}"...`,
          "loading",
          0,
        );
        try {
          const formData = new FormData();
          formData.append("action", "items.move");
          formData.append("id", item.id);
          formData.append("parent_id", destId);

          const moveRes = await apiFetch("api/index.php", {
            method: "POST",
            body: formData,
          });
          const moveData = await moveRes.json();

          if (moveData.success) {
            state.items = state.items.filter((it) => it.id !== item.id);
            renderItems();
            toastCtrl.update(
              `Moved "${item.name}" successfully.`,
              "success",
              2500,
            );
          } else {
            matchingElms.forEach((el) =>
              el.classList.remove("td-item-leaving"),
            );
            toastCtrl.update(
              moveData.error || "Failed to move item.",
              "error",
              4000,
            );
          }
        } catch (err) {
          console.error("Error moving item:", err);
          matchingElms.forEach((el) => el.classList.remove("td-item-leaving"));
          toastCtrl.update("Error moving item.", "error", 4000);
        }
      };
    } catch (err) {
      console.error("Error loading folders for move:", err);
      TeleDrive.toast("Could not load destination folders.", "error");
    }
  }

  // 13. Delete Item (Cascade) with Instant Optimistic Dimming & Persistent Toast
  async function handleDelete(item) {
    const isFolder = item.type === "folder";
    const confirmed = await TeleDrive.confirm({
      title: `Delete ${isFolder ? "Folder" : "File"}`,
      message: `Are you sure you want to permanently delete "${item.name}"?${isFolder ? " All files and subfolders inside will be wiped from Telegram storage." : ""}`,
      confirmText: "Delete Permanently",
      isDanger: true,
    });

    if (confirmed) {
      // Optimistic feedback: immediately dim the target card in the UI
      const matchingElms = document.querySelectorAll(
        `[data-item-id="${item.id}"]`,
      );
      matchingElms.forEach((el) => el.classList.add("td-item-deleting"));

      const toastCtrl = TeleDrive.toast(
        `Deleting "${item.name}" from Telegram storage...`,
        "loading",
        0,
      );
      try {
        const formData = new FormData();
        formData.append("action", "items.delete");
        formData.append("id", item.id);

        const res = await apiFetch("api/index.php", {
          method: "POST",
          body: formData,
        });
        const rawText = await res.text();
        let data = null;
        try {
          data = JSON.parse(rawText);
        } catch (jsonErr) {
          throw new Error(
            rawText.replace(/<[^>]*>?/gm, "").trim() ||
              "Server returned invalid response",
          );
        }

        if (data && data.success) {
          matchingElms.forEach((el) => el.classList.add("td-item-leaving"));
          setTimeout(() => {
            state.items = state.items.filter((it) => it.id !== item.id);
            renderItems();
          }, 200);
          toastCtrl.update(
            `"${item.name}" deleted from Telegram storage.`,
            "success",
            2500,
          );
        } else {
          matchingElms.forEach((el) => el.classList.remove("td-item-deleting"));
          toastCtrl.update(
            (data && data.error) || "Failed to delete item.",
            "error",
            4000,
          );
        }
      } catch (err) {
        console.error("Error deleting item:", err);
        matchingElms.forEach((el) => el.classList.remove("td-item-deleting"));
        toastCtrl.update(
          `Error deleting item: ${err.message || err}`,
          "error",
          4000,
        );
      }
    }
  }

  // 12b. Bulk Delete Action Handler
  async function handleBulkDelete() {
    const count = state.selectedIds.size;
    if (count === 0) return;

    const confirmed = await TeleDrive.confirm({
      title: "Delete Selected Items",
      message: `Are you sure you want to permanently delete ${count} selected item${count === 1 ? "" : "s"}? All contents inside selected folders will also be removed.`,
      confirmText: `Delete (${count})`,
      isDanger: true,
    });

    if (!confirmed) return;

    const idsToDelete = Array.from(state.selectedIds);
    idsToDelete.forEach((id) => {
      document
        .querySelectorAll(`[data-item-id="${id}"]`)
        .forEach((el) => el.classList.add("td-item-deleting"));
    });

    const toastCtrl = TeleDrive.toast(
      `Deleting ${count} selected item(s)...`,
      "loading",
      0,
    );
    try {
      const formData = new FormData();
      formData.append("action", "items.bulk_delete");
      formData.append("_csrf", getCsrfToken());
      formData.append("ids", JSON.stringify(idsToDelete));

      const res = await apiFetch("api/index.php", {
        method: "POST",
        body: formData,
      });
      const rawText = await res.text();
      let data = null;
      try {
        data = JSON.parse(rawText);
      } catch (jsonErr) {
        throw new Error(
          rawText.replace(/<[^>]*>?/gm, "").trim() ||
            "Server returned invalid response",
        );
      }

      if (data && data.success) {
        idsToDelete.forEach((id) => {
          document
            .querySelectorAll(`[data-item-id="${id}"]`)
            .forEach((el) => el.classList.add("td-item-leaving"));
        });
        setTimeout(() => {
          state.selectedIds.clear();
          state.items = state.items.filter(
            (it) => !idsToDelete.includes(it.id),
          );
          renderItems();
        }, 200);
        toastCtrl.update(
          data.message || `Deleted ${count} item(s) successfully.`,
          "success",
          2500,
        );
      } else {
        idsToDelete.forEach((id) => {
          document
            .querySelectorAll(`[data-item-id="${id}"]`)
            .forEach((el) => el.classList.remove("td-item-deleting"));
        });
        toastCtrl.update(
          (data && data.error) || "Failed to delete selected items.",
          "error",
          4000,
        );
      }
    } catch (err) {
      console.error("Error during bulk deletion:", err);
      idsToDelete.forEach((id) => {
        document
          .querySelectorAll(`[data-item-id="${id}"]`)
          .forEach((el) => el.classList.remove("td-item-deleting"));
      });
      toastCtrl.update(
        `Bulk delete error: ${err.message || err}`,
        "error",
        4000,
      );
    }
  }

  // Bulk Toolbar Event Listeners
  if (selectAllCheckbox) {
    selectAllCheckbox.onchange = () => {
      if (selectAllCheckbox.checked) {
        state.items.forEach((it) => state.selectedIds.add(it.id));
      } else {
        state.selectedIds.clear();
      }
      updateBulkBarUI();
    };
  }

  if (selectAllListCheckbox) {
    selectAllListCheckbox.onchange = () => {
      if (selectAllListCheckbox.checked) {
        state.items.forEach((it) => state.selectedIds.add(it.id));
      } else {
        state.selectedIds.clear();
      }
      updateBulkBarUI();
    };
  }

  if (bulkClearBtn) {
    bulkClearBtn.onclick = () => {
      state.selectedIds.clear();
      updateBulkBarUI();
    };
  }

  if (bulkDeleteBtn) {
    bulkDeleteBtn.onclick = handleBulkDelete;
  }

  // 13. Controlled Streaming Download with Progress Modal & Cancel
  async function startControlledDownload(fileItem) {
    const controller = new AbortController();
    const signal = controller.signal;

    // Create and show download status modal
    const overlay = document.createElement("div");
    overlay.className = "td-preview-modal";
    overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(6px);
            display: flex; align-items: center; justify-content: center;
            z-index: 9999;
        `;

    const box = document.createElement("div");
    box.className = "td-download-modal-box";

    box.innerHTML = `
            <div class="td-download-modal-header" style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                <div class="td-spinner" style="width:24px; height:24px; border:2px solid rgba(0,212,255,0.2); border-top-color:var(--color-primary); border-radius:50%; animation:tdSpin 0.8s linear infinite;"></div>
                <div style="flex:1; min-width:0;">
                    <h3 class="td-download-modal-title" style="font-size:16px; font-weight:600; color:var(--text-main);">Downloading File</h3>
                    <p class="td-download-modal-filename" style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(fileItem.name)}">${escapeHtml(fileItem.name)}</p>
                </div>
            </div>
            <div class="td-download-progress-bar" style="height:6px; background:var(--bg-body); border-radius:3px; overflow:hidden; margin-bottom:12px;">
                <div class="td-download-progress-fill" id="td-dl-progress-fill" style="height:100%; width:0%; background:var(--color-primary); transition:width 0.1s linear;"></div>
            </div>
            <div class="td-download-modal-meta" style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-secondary);">
                <span class="td-download-modal-percent" id="td-dl-percent">0%</span>
                <span class="td-download-modal-size" id="td-dl-size">0 B / ${formatBytes(fileItem.size)}</span>
                <span class="td-download-modal-speed" id="td-dl-speed">Starting...</span>
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:16px;">
                <button id="td-cancel-download-btn" style="
                    background: transparent; border: 1px solid var(--border-color);
                    color: var(--color-danger, #ef4444); padding: 6px 14px;
                    border-radius: var(--radius-sm, 6px); cursor: pointer; font-size:12px; font-weight:500;
                    transition: all 0.2s ease;
                ">Cancel Download</button>
            </div>
        `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const dlFill = box.querySelector("#td-dl-progress-fill");
    const dlPercent = box.querySelector("#td-dl-percent");
    const dlSize = box.querySelector("#td-dl-size");
    const dlSpeed = box.querySelector("#td-dl-speed");

    let isCancelled = false;
    box.querySelector("#td-cancel-download-btn").onclick = () => {
      isCancelled = true;
      controller.abort();
      overlay.remove();
      TeleDrive.toast("Download cancelled.", "warning");
    };

    try {
      const downloadUrl = `/api/index.php?action=files.download&id=${encodeURIComponent(fileItem.id)}`;
      const response = await fetch(downloadUrl, { signal });

      if (!response.ok) {
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errData = await response.json();
          if (errData && errData.error) errorMsg = errData.error;
        } catch (e) {}
        throw new Error(errorMsg);
      }

      const contentLengthHeader = response.headers.get("Content-Length");
      const totalBytes = contentLengthHeader
        ? parseInt(contentLengthHeader, 10)
        : fileItem.size || 0;

      const reader = response.body.getReader();
      const chunks = [];
      let receivedBytes = 0;
      const startTime = Date.now();

      while (true) {
        if (isCancelled) break;
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        receivedBytes += value.length;

        const percent =
          totalBytes > 0
            ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
            : 0;
        dlFill.style.width = `${percent}%`;
        dlPercent.textContent = `${percent}%`;
        dlSize.textContent =
          totalBytes > 0
            ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
            : `${formatBytes(receivedBytes)}`;

        const elapsedSec = (Date.now() - startTime) / 1000;
        if (elapsedSec > 0.4 && receivedBytes > 0) {
          const speed = receivedBytes / elapsedSec;
          dlSpeed.textContent = `${formatBytes(speed)}/s`;
        }
      }

      if (!isCancelled) {
        dlFill.style.width = "100%";
        dlPercent.textContent = "100%";
        dlSpeed.textContent = "Finalizing...";

        const blob = new Blob(chunks, {
          type: fileItem.mime_type || "application/octet-stream",
        });
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileItem.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(blobUrl);

        setTimeout(() => {
          overlay.remove();
          TeleDrive.toast(`Download complete: ${fileItem.name}`, "success");
        }, 400);
      }
    } catch (err) {
      overlay.remove();
      if (!isCancelled) {
        console.error("Download error:", err);
        TeleDrive.toast(`Download failed: ${err.message}`, "error");
      }
    }
  }

  // 14. File Upload Trigger & Input Handlers
  uploadTrigger.onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    if (e.target.files.length > 0) {
      handleFilesUpload(Array.from(e.target.files));
      fileInput.value = "";
    }
  };

  // 15. Drag and Drop Support
  let dragCounter = 0;
  dropzone.ondragenter = (e) => {
    e.preventDefault();
    dragCounter++;
    dragOverlay.classList.add("active");
  };

  dropzone.ondragleave = (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      dragOverlay.classList.remove("active");
    }
  };

  dropzone.ondragover = (e) => e.preventDefault();

  dropzone.ondrop = (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove("active");
    if (e.dataTransfer.files.length > 0) {
      handleFilesUpload(Array.from(e.dataTransfer.files));
    }
  };

  queueClose.onclick = () => {
    uploadQueue.style.display = "none";
  };

  // 16. Client-Side Chunked File Upload Engine with Cancellation
  async function handleFilesUpload(files) {
    if (!files || files.length === 0) return;

    uploadQueue.style.display = "block";

    for (const file of files) {
      await uploadSingleFile(file);
    }

    // Auto-hide upload queue once everything completes
    setTimeout(() => {
      if (queueItems.children.length === 0) {
        uploadQueue.style.display = "none";
      }
    }, 2000);

    await loadFolder(state.currentFolderId);

    // If 50-message compaction triggered during queue, run non-blocking index purge
    if (state.needsIndexPurge) {
      await triggerIndexPurge();
    }
  }

  async function triggerIndexPurge() {
    state.needsIndexPurge = false;

    // Temporarily disable actions to prevent race conditions during purge
    if (uploadTrigger) {
      uploadTrigger.disabled = true;
      uploadTrigger.style.opacity = "0.5";
      uploadTrigger.style.pointerEvents = "none";
    }
    if (newFolderBtn) {
      newFolderBtn.disabled = true;
      newFolderBtn.style.opacity = "0.5";
      newFolderBtn.style.pointerEvents = "none";
    }

    const toastCtrl = TeleDrive.toast(
      "Please wait while clearing junk files...",
      "loading",
      0,
    );

    try {
      const formData = new FormData();
      formData.append("action", "system.purge_index_messages");
      formData.append("_csrf", getCsrfToken());

      const res = await apiFetch("api/index.php", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (data && data.success && data.purged) {
        toastCtrl.update(
          "Clearing junk files success! You can now upload or create folders.",
          "success",
          3500,
        );
      } else {
        toastCtrl.update("Clearing junk files success!", "success", 2000);
      }
    } catch (err) {
      console.error("Error purging index junk messages:", err);
      toastCtrl.update("Index optimization finished.", "info", 2000);
    } finally {
      if (uploadTrigger) {
        uploadTrigger.disabled = false;
        uploadTrigger.style.opacity = "";
        uploadTrigger.style.pointerEvents = "";
      }
      if (newFolderBtn) {
        newFolderBtn.disabled = false;
        newFolderBtn.style.opacity = "";
        newFolderBtn.style.pointerEvents = "";
      }
    }
  }

  async function uploadSingleFile(file) {
    const TWO_GB_LIMIT = 1.95 * 1024 * 1024 * 1024; // 1.95 GB
    const isMultiPart = file.size > TWO_GB_LIMIT;
    let isCancelled = false;
    const activeXhrs = new Set();

    // Create UI Item in queue with Cancel button, Percentage, Size & Status indicators
    const qItem = document.createElement("div");
    qItem.className = "td-queue-item";
    qItem.innerHTML = `
            <div class="td-queue-item-top">
                <div class="td-queue-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                <button class="td-queue-item-cancel" title="Cancel upload">✕ Cancel</button>
            </div>
            <div class="td-queue-progress-bar">
                <div class="td-queue-progress-fill"></div>
            </div>
            <div class="td-queue-item-meta">
                <span class="td-queue-percent">0%</span>
                <span class="td-queue-size">0 B / ${formatBytes(file.size)}</span>
                <span class="td-queue-speed">Starting...</span>
            </div>
        `;
    queueItems.appendChild(qItem);
    const fillBar = qItem.querySelector(".td-queue-progress-fill");
    const cancelBtn = qItem.querySelector(".td-queue-item-cancel");
    const percentLabel = qItem.querySelector(".td-queue-percent");
    const sizeLabel = qItem.querySelector(".td-queue-size");
    const speedLabel = qItem.querySelector(".td-queue-speed");

    cancelBtn.onclick = () => {
      isCancelled = true;
      activeXhrs.forEach((xhr) => {
        try {
          xhr.abort();
        } catch (e) {}
      });
      activeXhrs.clear();
      qItem.remove();
      TeleDrive.toast(`Upload cancelled: ${file.name}`, "warning");
      if (queueItems.children.length === 0) {
        uploadQueue.style.display = "none";
      }
    };

    const startTime = Date.now();

    try {
      if (!isMultiPart) {
        const uploadId = "up_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
        let progressInterval = null;

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          activeXhrs.add(xhr);

          let isFinished = false;

          // Poll server for live Telegram MTProto upload progress
          progressInterval = setInterval(async () => {
            if (isCancelled || isFinished) {
              if (progressInterval) clearInterval(progressInterval);
              return;
            }
            try {
              const pRes = await fetch(`/api/index.php?action=files.upload_progress&upload_id=${encodeURIComponent(uploadId)}`);
              const pJson = await pRes.json();
              const pData = pJson.progress || (pJson.data && pJson.data.progress);
              if (pData && pData.status === "uploading_telegram") {
                const tgPercent = pData.percent || 0;
                // Combine: 50% for browser buffer + 50% for telegram upload
                const totalPercent = Math.min(99, 50 + Math.round(tgPercent * 0.49));
                fillBar.style.width = `${totalPercent}%`;
                percentLabel.textContent = `${totalPercent}%`;
                sizeLabel.textContent = `${formatBytes(pData.loaded || 0)} / ${formatBytes(file.size)}`;
                if (pData.speed > 0) {
                  speedLabel.textContent = `${formatBytes(pData.speed)}/s (Telegram Cloud)`;
                } else {
                  speedLabel.textContent = `Uploading to Telegram Cloud...`;
                }
              } else if (pData && pData.status === "indexing") {
                fillBar.style.width = `99%`;
                percentLabel.textContent = `99%`;
                speedLabel.textContent = `Saving metadata...`;
              } else if (pData && pData.status === "completed" && pData.item && !isFinished) {
                // If Telegram completed before XHR fired load
                isFinished = true;
                if (progressInterval) clearInterval(progressInterval);
                activeXhrs.delete(xhr);
                state.items.unshift(pData.item);
                renderItems();
                if (pData.needs_purge) {
                  state.needsIndexPurge = true;
                }
                resolve({ success: true, item: pData.item });
              }
            } catch (e) {}
          }, 350);

          xhr.upload.onprogress = (e) => {
            if (isCancelled || isFinished) return;
            if (e.lengthComputable && e.loaded <= file.size) {
              // Browser upload represents first 50% of full progress
              const localPercent = Math.min(50, Math.round((e.loaded / file.size) * 50));
              fillBar.style.width = `${localPercent}%`;
              percentLabel.textContent = `${localPercent}%`;
              sizeLabel.textContent = `${formatBytes(e.loaded)} / ${formatBytes(file.size)}`;
              const elapsedSec = (Date.now() - startTime) / 1000;
              if (elapsedSec > 0.3) {
                const speed = e.loaded / elapsedSec;
                speedLabel.textContent = `${formatBytes(speed)}/s (Buffering)`;
              } else {
                speedLabel.textContent = "Uploading to server...";
              }
            }
          };

          xhr.onload = async () => {
            if (isFinished) return;
            if (progressInterval) clearInterval(progressInterval);
            activeXhrs.delete(xhr);
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const json = JSON.parse(xhr.responseText);
                if (json && json.success) {
                  isFinished = true;
                  const newItem = json.item || (json.data && json.data.item) || json.folder;
                  if (newItem) {
                    state.items.unshift(newItem);
                    renderItems();
                  }
                  if (json.needs_purge || (json.data && json.data.needs_purge)) {
                    state.needsIndexPurge = true;
                  }
                  resolve(json);
                  return;
                } else {
                  reject(new Error(json?.error || json?.message || "Direct upload failed"));
                  return;
                }
              } catch (parseErr) {
                // Fallback check: Did Telegram complete in progress tracker?
                try {
                  const checkRes = await fetch(`/api/index.php?action=files.upload_progress&upload_id=${encodeURIComponent(uploadId)}`);
                  const checkJson = await checkRes.json();
                  const pData = checkJson.progress || (checkJson.data && checkJson.data.progress);
                  if (pData && (pData.status === "completed" || pData.item)) {
                    isFinished = true;
                    if (pData.item) {
                      state.items.unshift(pData.item);
                      renderItems();
                    }
                    resolve({ success: true, item: pData.item });
                    return;
                  }
                } catch (e) {}
                reject(new Error(`Server returned invalid response (HTTP ${xhr.status})`));
                return;
              }
            } else {
              // Check if upload actually completed on Telegram before rejecting
              try {
                const checkRes = await fetch(`/api/index.php?action=files.upload_progress&upload_id=${encodeURIComponent(uploadId)}`);
                const checkJson = await checkRes.json();
                const pData = checkJson.progress || (checkJson.data && checkJson.data.progress);
                if (pData && (pData.status === "completed" || pData.item)) {
                  isFinished = true;
                  if (pData.item) {
                    state.items.unshift(pData.item);
                    renderItems();
                  }
                  resolve({ success: true, item: pData.item });
                  return;
                }
              } catch (e) {}

              let errorMsg = `HTTP error ${xhr.status}`;
              try {
                const errJson = JSON.parse(xhr.responseText);
                if (errJson && errJson.error) errorMsg = errJson.error;
              } catch (e) {}
              reject(new Error(errorMsg));
            }
          };

          xhr.onerror = async () => {
            if (isFinished) return;
            if (progressInterval) clearInterval(progressInterval);
            activeXhrs.delete(xhr);

            // Double check progress tracker in case network dropped right after upload to Telegram
            try {
              const checkRes = await fetch(`/api/index.php?action=files.upload_progress&upload_id=${encodeURIComponent(uploadId)}`);
              const checkJson = await checkRes.json();
              const pData = checkJson.progress || (checkJson.data && checkJson.data.progress);
              if (pData && (pData.status === "completed" || pData.item)) {
                isFinished = true;
                if (pData.item) {
                  state.items.unshift(pData.item);
                  renderItems();
                }
                resolve({ success: true, item: pData.item });
                return;
              }
            } catch (e) {}

            reject(new Error("Network error during direct upload"));
          };

          xhr.onabort = () => {
            if (isFinished) return;
            if (progressInterval) clearInterval(progressInterval);
            activeXhrs.delete(xhr);
            reject(new Error("Upload aborted"));
          };

          const formData = new FormData();
          formData.append("action", "files.direct_upload");
          formData.append("_csrf", getCsrfToken());
          formData.append("upload_id", uploadId);
          formData.append("parent_id", state.currentFolderId);
          formData.append("filename", file.name);
          formData.append("file", file);

          xhr.open("POST", "/api/upload", true);
          xhr.timeout = 0; // Prevent client socket timeout
          xhr.setRequestHeader("X-CSRF-Token", getCsrfToken());
          xhr.send(formData);
        });
      } else {
        // --- 2. Multi-Part Volumes ONLY for Large Files > 2GB (1.9GB Slices) ---
        const volumeSize = Math.floor(1.9 * 1024 * 1024 * 1024);
        const totalParts = Math.ceil(file.size / volumeSize);
        const uploadId = "up_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);

        for (let partIdx = 0; partIdx < totalParts && !isCancelled; partIdx++) {
          const start = partIdx * volumeSize;
          const end = Math.min(start + volumeSize, file.size);
          const partBlob = file.slice(start, end);

          await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            activeXhrs.add(xhr);

            xhr.upload.onprogress = (e) => {
              if (isCancelled) return;
              if (e.lengthComputable) {
                const currentLoaded = (partIdx * volumeSize) + e.loaded;
                const percent = Math.min(99, Math.round((currentLoaded / file.size) * 100));
                fillBar.style.width = `${percent}%`;
                percentLabel.textContent = `${percent}% (Part ${partIdx + 1}/${totalParts})`;
                sizeLabel.textContent = `${formatBytes(currentLoaded)} / ${formatBytes(file.size)}`;

                const elapsedSec = (Date.now() - startTime) / 1000;
                if (elapsedSec > 0.4) {
                  const speedBytesPerSec = currentLoaded / elapsedSec;
                  speedLabel.textContent = `${formatBytes(speedBytesPerSec)}/s`;
                }
              }
            };

            xhr.onload = () => {
              activeXhrs.delete(xhr);
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
              } else {
                reject(new Error(`Failed to upload part ${partIdx + 1}`));
              }
            };

            xhr.onerror = () => {
              activeXhrs.delete(xhr);
              reject(new Error(`Network error on part ${partIdx + 1}`));
            };

            const formData = new FormData();
            formData.append("action", "files.upload_chunk");
            formData.append("_csrf", getCsrfToken());
            formData.append("upload_id", uploadId);
            formData.append("chunk_index", partIdx);
            formData.append("total_chunks", totalParts);
            formData.append("filename", file.name);
            formData.append("chunk", partBlob, file.name);

            xhr.open("POST", "/api/index.php?action=files.upload_chunk", true);
            xhr.setRequestHeader("X-CSRF-Token", getCsrfToken());
            xhr.send(formData);
          });
        }

        if (isCancelled) return;

        // Finalize multipart upload
        const completeFormData = new FormData();
        completeFormData.append("action", "files.complete_upload");
        completeFormData.append("_csrf", getCsrfToken());
        completeFormData.append("upload_id", uploadId);
        completeFormData.append("filename", file.name);
        completeFormData.append("size", file.size);
        completeFormData.append("parent_id", state.currentFolderId);
        completeFormData.append("total_chunks", totalParts);

        const completeRes = await apiFetch("/api/index.php?action=files.complete_upload", {
          method: "POST",
          body: completeFormData,
        });
        const completeResult = await completeRes.json();
        if (completeResult.success) {
          const newItem = completeResult.item || (completeResult.data && completeResult.data.item);
          if (newItem) {
            state.items.unshift(newItem);
            renderItems();
          }
        } else {
          throw new Error(completeResult.error || "Failed to finalize multipart upload");
        }
      }

      if (isCancelled) return;

      fillBar.style.width = "100%";
      percentLabel.textContent = "100%";
      sizeLabel.textContent = `${formatBytes(file.size)} / ${formatBytes(file.size)}`;
      speedLabel.textContent = "Completed!";
      cancelBtn.style.display = "none";
      TeleDrive.toast(`Uploaded: ${file.name}`, "success");

      setTimeout(() => {
        qItem.style.opacity = "0";
        qItem.style.transform = "translateX(20px)";
        setTimeout(() => {
          qItem.remove();
          if (queueItems.children.length === 0) {
            uploadQueue.style.display = "none";
          }
        }, 300);
      }, 1500);
    } catch (err) {
      if (!isCancelled) {
        TeleDrive.toast(
          `Upload failed for ${file.name}: ${err.message}`,
          "error",
        );
        speedLabel.textContent = "Failed";
        fillBar.style.backgroundColor = "var(--color-danger, #ef4444)";
      }
    }
  }

  // Utility Helpers
  function getFileIcon(item) {
    if (item.type === "folder") {
      return { icon: "📁", colorClass: "td-icon-folder" };
    }
    const mime = item.mime_type || "";
    if (mime.startsWith("image/"))
      return { icon: "🖼️", colorClass: "td-icon-image" };
    if (mime.startsWith("video/"))
      return { icon: "🎬", colorClass: "td-icon-video" };
    if (mime.startsWith("audio/"))
      return { icon: "🎵", colorClass: "td-icon-audio" };
    if (mime.includes("pdf")) return { icon: "📕", colorClass: "td-icon-pdf" };
    if (
      mime.includes("zip") ||
      mime.includes("rar") ||
      mime.includes("tar") ||
      mime.includes("7z")
    ) {
      return { icon: "📦", colorClass: "td-icon-archive" };
    }
    if (
      mime.includes("javascript") ||
      mime.includes("json") ||
      mime.includes("xml") ||
      mime.includes("html") ||
      mime.includes("css")
    ) {
      return { icon: "💻", colorClass: "td-icon-code" };
    }
    return { icon: "📄", colorClass: "td-icon-default" };
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const k = 1000;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function formatDate(timestamp) {
    if (!timestamp) return "—";
    let date;
    if (typeof timestamp === "number") {
      date = new Date(timestamp < 10000000000 ? timestamp * 1000 : timestamp);
    } else if (typeof timestamp === "string") {
      const trimmed = timestamp.trim();
      if (/^\d+$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        date = new Date(num < 10000000000 ? num * 1000 : num);
      } else {
        date = new Date(trimmed);
      }
    } else {
      date = new Date(timestamp);
    }

    if (!date || isNaN(date.getTime())) return "—";

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
});
