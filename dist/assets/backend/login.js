document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('td-login-form');
    const submitBtn = document.getElementById('td-login-btn');
    const btnText = submitBtn.querySelector('.td-btn-text');
    const spinner = submitBtn.querySelector('.td-spinner');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = form.username.value.trim();
        const password = form.password.value;

        if (!username || !password) {
            TeleDrive.toast('Please enter both username and password.', 'warning');
            return;
        }

        submitBtn.disabled = true;
        btnText.style.display = 'none';
        spinner.style.display = 'block';

        try {
            const formData = new FormData();
            formData.append('action', 'auth.login');
            formData.append('username', username);
            formData.append('password', password);

            const res = await fetch('/api/index.php', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();

            if (data.success) {
                TeleDrive.toast('Authentication successful. Redirecting...', 'success');
                setTimeout(() => {
                    window.location.href = '/';
                }, 800);
            } else {
                TeleDrive.toast(data.error || 'Invalid credentials.', 'error');
                submitBtn.disabled = false;
                btnText.style.display = 'block';
                spinner.style.display = 'none';
            }
        } catch (err) {
            TeleDrive.toast('Network error during authentication.', 'error');
            submitBtn.disabled = false;
            btnText.style.display = 'block';
            spinner.style.display = 'none';
        }
    });
});
