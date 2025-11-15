# 🚀 Deploy to GitHub Pages - Step by Step

## ✅ Current Status:
- ✅ Code is ready
- ✅ Configured for deployment
- ✅ Git commit created

## ⚠️ Account Issue:
You're logged in as `raahull46` but trying to push to `rahull-prog/iiitnrattendence`

---

## 🎯 **OPTION 1: Use Repository Under `rahull-prog` Account** (Recommended if it's your account)

### Step 1: Login to GitHub with `rahull-prog` Account

Open PowerShell and run:

```powershell
# Configure git with rahull-prog account
git config --global user.name "rahull-prog"
git config --global user.email "YOUR_EMAIL@example.com"  # Replace with rahull-prog's email

# Clear cached credentials
git credential-cache exit
# OR on Windows:
cmdkey /delete:LegacyGeneric:target=git:https://github.com
```

### Step 2: Push to Repository

```powershell
cd d:\GeoFence-QR-Attendance
git push -u origin main --force
```

When prompted, enter **`rahull-prog`'s GitHub username and Personal Access Token**.

### Step 3: Deploy to GitHub Pages

```powershell
cd FacultyApp
npm install --save-dev gh-pages
npm run deploy
```

### Step 4: Enable GitHub Pages

1. Go to: https://github.com/rahull-prog/iiitnrattendence/settings/pages
2. Source: Select `gh-pages` branch
3. Click Save

**Your portal will be live at:** `https://rahull-prog.github.io/iiitnrattendence/`

---

## 🎯 **OPTION 2: Create New Repository Under `raahull46` Account** (Simpler)

### Step 1: Create New Repository

1. Go to: https://github.com/new
2. Repository name: `iiitnrattendence`
3. Make it **Public**
4. Click "Create repository"

### Step 2: Update Remote URL

```powershell
cd d:\GeoFence-QR-Attendance
git remote set-url origin https://github.com/raahull46/iiitnrattendence.git
```

### Step 3: Update Configuration Files

Edit `FacultyApp/package.json`, change line 6 to:
```json
"homepage": "https://raahull46.github.io/iiitnrattendence",
```

### Step 4: Push to GitHub

```powershell
git add .
git commit -m "Update GitHub username"
git push -u origin main
```

### Step 5: Deploy to GitHub Pages

```powershell
cd FacultyApp
npm install --save-dev gh-pages
npm run deploy
```

### Step 6: Enable GitHub Pages

1. Go to: https://github.com/raahull46/iiitnrattendence/settings/pages
2. Source: Select `gh-pages` branch
3. Click Save

**Your portal will be live at:** `https://raahull46.github.io/iiitnrattendence/`

---

## 🎯 **OPTION 3: Add `raahull46` as Collaborator** (If `rahull-prog` is someone else)

If `rahull-prog` is a team member:

1. Ask `rahull-prog` to go to: https://github.com/rahull-prog/iiitnrattendence/settings/access
2. Click "Add people"
3. Add `raahull46` as collaborator
4. Accept invitation
5. Then you can push using your `raahull46` account

---

## 📊 Recommendation

**Use OPTION 2** (your own account `raahull46`) because:
- ✅ Simpler - no permission issues
- ✅ You have full control
- ✅ Can deploy immediately
- ✅ Same result - working attendance portal

The URL will be:
```
https://raahull46.github.io/iiitnrattendence/
```

Instead of:
```
https://rahull-prog.github.io/iiitnrattendence/
```

**Both URLs work exactly the same!** Faculty won't care about the GitHub username in the URL.

---

## ❓ Which Option to Choose?

- **If `rahull-prog` is YOUR account** → Use Option 1
- **If you prefer simpler setup** → Use Option 2 (your `raahull46` account)
- **If `rahull-prog` is your teammate** → Use Option 3 (collaborator)

---

## 🚀 Next Steps After Choosing

Once you successfully push and deploy:

1. **Deploy Backend to Render** (see `GITHUB_PAGES_DEPLOY.md`)
2. **Update `.env.production` with backend URL**
3. **Redeploy frontend:** `npm run deploy`
4. **Test your live portal!**

---

**Let me know which option you want, and I'll guide you through it!**
