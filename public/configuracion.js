const token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/login.html';
}

let currentUser = null;
let currentCompany = null;

// Load initial data
async function loadUserData() {
  try {
    const meRes = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const meData = await meRes.json();
    currentUser = meData.user;

    // Load user profile data
    document.getElementById('profile-name').value = currentUser.name || '';
    document.getElementById('profile-email').value = currentUser.email || '';
    document.getElementById('profile-avatar').value = currentUser.avatar_url || '';

    // Load company data if exists
    if (currentUser.company_id) {
      const companyRes = await fetch(`/api/companies/${currentUser.company_id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const companyData = await companyRes.json();
      currentCompany = companyData.company;

      document.getElementById('company-name').value = currentCompany.name || '';
      document.getElementById('company-description').value = currentCompany.description || '';
      document.getElementById('company-timezone').value = currentCompany.timezone || 'America/New_York';
      document.getElementById('company-logo').value = currentCompany.logo_url || '';
    }

    // Load subscription data
    loadSubscriptionData();

    // Load balance
    document.getElementById('withdrawal-balance').textContent = `$${((currentUser.balance_cents || 0) / 100).toFixed(2)}`;

  } catch (error) {
    console.error('Failed to load user data:', error);
    alert('Error al cargar datos del usuario');
  }
}

async function loadSubscriptionData() {
  try {
    const [billingRes, usageRes] = await Promise.all([
      fetch('/api/billing', { headers: { 'Authorization': `Bearer ${token}` } }),
      fetch('/api/billing/usage', { headers: { 'Authorization': `Bearer ${token}` } })
    ]);

    const billing = await billingRes.json();
    const usage = await usageRes.json();

    document.getElementById('current-plan').textContent = `Plan ${billing.plan || 'Gratis'}`;
    document.getElementById('api-calls-used').textContent = usage.api_calls || 0;
    document.getElementById('api-calls-limit').textContent = usage.api_calls_limit || 100;
    document.getElementById('llm-calls-used').textContent = usage.llm_calls || 0;
    document.getElementById('llm-calls-limit').textContent = usage.llm_calls_limit || 10;

    const apiPercent = ((usage.api_calls || 0) / (usage.api_calls_limit || 100)) * 100;
    const llmPercent = ((usage.llm_calls || 0) / (usage.llm_calls_limit || 10)) * 100;

    document.getElementById('api-calls-bar').style.width = `${Math.min(apiPercent, 100)}%`;
    document.getElementById('llm-calls-bar').style.width = `${Math.min(llmPercent, 100)}%`;
  } catch (error) {
    console.error('Failed to load subscription data:', error);
  }
}

async function loadApiKeys() {
  try {
    const res = await fetch('/api/keys', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    const list = document.getElementById('api-keys-list');
    if (data.keys.length === 0) {
      list.innerHTML = '<p class="text-gray-400">No tienes claves API. Crea una para comenzar.</p>';
      return;
    }

    list.innerHTML = data.keys.map(key => `
      <div class="flex items-center justify-between p-4 bg-gray-700 rounded-lg">
        <div>
          <p class="font-medium">${key.name}</p>
          <p class="text-sm text-gray-400">Último uso: ${key.last_used_at ? new Date(key.last_used_at).toLocaleDateString('es') : 'Nunca'}</p>
          <p class="text-xs text-gray-500 mt-1">${key.key_prefix}...</p>
        </div>
        <button onclick="revokeKey(${key.id})" class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition">
          Revocar
        </button>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load API keys:', error);
  }
}

async function loadQuickLinks() {
  try {
    const res = await fetch('/api/settings/quick-links', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    const list = document.getElementById('quick-links-list');
    if (data.links.length === 0) {
      list.innerHTML = '<p class="text-gray-400">No tienes enlaces rápidos. Agrega uno para comenzar.</p>';
      return;
    }

    list.innerHTML = data.links.map(link => `
      <div class="flex items-center justify-between p-4 bg-gray-700 rounded-lg">
        <div>
          <p class="font-medium">${link.title}</p>
          <a href="${link.url}" target="_blank" class="text-sm text-blue-400 hover:underline">${link.url}</a>
        </div>
        <button onclick="deleteLink(${link.id})" class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition">
          Eliminar
        </button>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load quick links:', error);
  }
}

// Tab switching
function switchTab(tab) {
  // Hide all tabs
  ['profile', 'company', 'api', 'subscription', 'withdrawal', 'links'].forEach(t => {
    document.getElementById(`content-${t}`).classList.add('hidden');
    document.getElementById(`tab-${t}`).classList.remove('tab-active');
    document.getElementById(`tab-${t}`).classList.add('text-gray-400');
  });

  // Show selected tab
  document.getElementById(`content-${tab}`).classList.remove('hidden');
  document.getElementById(`tab-${tab}`).classList.add('tab-active');
  document.getElementById(`tab-${tab}`).classList.remove('text-gray-400');

  // Load data for specific tabs
  if (tab === 'api') loadApiKeys();
  if (tab === 'links') loadQuickLinks();
}

// Profile form
document.getElementById('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('profile-name').value;
  const avatar_url = document.getElementById('profile-avatar').value;

  try {
    const res = await fetch('/api/settings/profile', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, avatar_url })
    });

    if (res.ok) {
      alert('Perfil actualizado exitosamente');
    } else {
      alert('Error al actualizar perfil');
    }
  } catch (error) {
    console.error('Failed to update profile:', error);
    alert('Error al actualizar perfil');
  }
});

// Password form
document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = document.getElementById('current-password').value;
  const newPass = document.getElementById('new-password').value;
  const confirm = document.getElementById('confirm-password').value;

  if (newPass !== confirm) {
    alert('Las contraseñas no coinciden');
    return;
  }

  try {
    const res = await fetch('/api/settings/password', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ current_password: current, new_password: newPass })
    });

    if (res.ok) {
      alert('Contraseña actualizada exitosamente');
      e.target.reset();
    } else {
      const data = await res.json();
      alert(data.error || 'Error al actualizar contraseña');
    }
  } catch (error) {
    console.error('Failed to update password:', error);
    alert('Error al actualizar contraseña');
  }
});

// Company form
document.getElementById('company-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('company-name').value;
  const description = document.getElementById('company-description').value;
  const timezone = document.getElementById('company-timezone').value;
  const logo_url = document.getElementById('company-logo').value;

  try {
    const res = await fetch(`/api/companies/${currentUser.company_id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, description, timezone, logo_url })
    });

    if (res.ok) {
      alert('Configuración de empresa actualizada exitosamente');
    } else {
      alert('Error al actualizar configuración');
    }
  } catch (error) {
    console.error('Failed to update company:', error);
    alert('Error al actualizar configuración');
  }
});

// Withdrawal form
document.getElementById('withdrawal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('withdrawal-amount').value);
  const method = document.getElementById('withdrawal-method').value;
  const details = document.getElementById('withdrawal-details').value;

  if (amount < 50) {
    alert('El monto mínimo es $50 USD');
    return;
  }

  try {
    const res = await fetch('/api/settings/withdrawal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount_cents: Math.round(amount * 100),
        payment_method: method,
        payment_details: { details }
      })
    });

    if (res.ok) {
      alert('Solicitud de retiro enviada exitosamente. Procesaremos tu solicitud en 3-5 días hábiles.');
      e.target.reset();
      loadUserData(); // Refresh balance
    } else {
      const data = await res.json();
      alert(data.error || 'Error al solicitar retiro');
    }
  } catch (error) {
    console.error('Failed to request withdrawal:', error);
    alert('Error al solicitar retiro');
  }
});

// API Key modals
function showCreateKeyModal() {
  document.getElementById('create-key-modal').classList.remove('hidden');
}

function hideCreateKeyModal() {
  document.getElementById('create-key-modal').classList.add('hidden');
  document.getElementById('create-key-form').reset();
}

document.getElementById('create-key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-key-name').value;

  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name })
    });

    if (res.ok) {
      const data = await res.json();
      alert(`Clave creada exitosamente!\n\nGuarda esta clave en un lugar seguro:\n${data.key}\n\nNo podrás volver a verla.`);
      hideCreateKeyModal();
      loadApiKeys();
    } else {
      alert('Error al crear clave');
    }
  } catch (error) {
    console.error('Failed to create API key:', error);
    alert('Error al crear clave');
  }
});

async function revokeKey(keyId) {
  if (!confirm('¿Estás seguro de revocar esta clave? Esta acción no se puede deshacer.')) {
    return;
  }

  try {
    const res = await fetch(`/api/keys/${keyId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      alert('Clave revocada exitosamente');
      loadApiKeys();
    } else {
      alert('Error al revocar clave');
    }
  } catch (error) {
    console.error('Failed to revoke API key:', error);
    alert('Error al revocar clave');
  }
}

// Quick Links modals
function showAddLinkModal() {
  document.getElementById('add-link-modal').classList.remove('hidden');
}

function hideAddLinkModal() {
  document.getElementById('add-link-modal').classList.add('hidden');
  document.getElementById('add-link-form').reset();
}

document.getElementById('add-link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('new-link-title').value;
  const url = document.getElementById('new-link-url').value;

  try {
    const res = await fetch('/api/settings/quick-links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, url })
    });

    if (res.ok) {
      alert('Enlace agregado exitosamente');
      hideAddLinkModal();
      loadQuickLinks();
    } else {
      alert('Error al agregar enlace');
    }
  } catch (error) {
    console.error('Failed to add quick link:', error);
    alert('Error al agregar enlace');
  }
});

async function deleteLink(linkId) {
  if (!confirm('¿Estás seguro de eliminar este enlace?')) {
    return;
  }

  try {
    const res = await fetch(`/api/settings/quick-links/${linkId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      alert('Enlace eliminado exitosamente');
      loadQuickLinks();
    } else {
      alert('Error al eliminar enlace');
    }
  } catch (error) {
    console.error('Failed to delete quick link:', error);
    alert('Error al eliminar enlace');
  }
}

// Initialize
loadUserData();
