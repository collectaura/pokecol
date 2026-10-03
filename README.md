# PokéVault Tracker : version automatique

Cette version de PokéVault met à jour les prix Cardmarket toute seule, chaque jour, sans que tu aies à importer de fichier.

Un robot gratuit, qui tourne sur les serveurs de GitHub, récupère chaque jour les fichiers de prix publiés par Cardmarket. Il les range dans le dossier `data/` de ton dépôt. Ton site, hébergé gratuitement par GitHub Pages, lit ces fichiers à chaque ouverture, puis toutes les heures tant qu'il reste ouvert. L'historique jour par jour est gardé pour tout le scellé et pour les cartes que tu suis. Tes courbes se remplissent donc même les jours où tu n'ouvres pas l'appli.

## Mise en place (une seule fois, environ 15 minutes)

### 1. Créer le dépôt
1. Crée un compte gratuit sur github.com si tu n'en as pas.
2. Clique sur **New repository**, nomme-le `pokevault` et choisis **Public**. Il faut un dépôt public pour utiliser GitHub Pages gratuitement. Ta collection n'y est jamais envoyée : elle reste dans ton navigateur. Seuls l'appli et les prix publics de Cardmarket sont dans le dépôt.
3. Dans le dépôt, clique sur **Add file > Upload files** et glisse tout le contenu de ce dossier : `index.html`, `README.md`, `data`, `scripts` et `.github`.

Si le dossier `.github` n'apparaît pas, c'est un dossier caché. Sur Mac, fais Cmd+Maj+point pour l'afficher. Sinon, crée le fichier à la main : **Add file > Create new file**, tape le nom `.github/workflows/update-prices.yml`, puis colle le contenu du fichier fourni.

### 2. Donner les liens des fichiers Cardmarket
Cardmarket publie chaque jour un guide des prix et un catalogue des produits, en fichiers JSON téléchargeables.
1. Sur le site de Cardmarket, trouve la page de téléchargement de ces fichiers pour Pokémon. Copie le lien du **guide des prix** et les liens des **catalogues de produits** : cartes (singles) et produits scellés (non-singles).
2. Dans ton dépôt GitHub, va dans **Settings > Secrets and variables > Actions**, ouvre l'onglet **Variables**, puis clique sur **New repository variable**.
3. Crée la variable `CM_PRICE_GUIDE_URL` et colle comme valeur le lien du guide des prix.
4. Crée la variable `CM_PRODUCTS_URLS` et colle comme valeur les liens des catalogues, séparés par un espace.

### 3. Autoriser le robot à enregistrer les prix
Va dans **Settings > Actions > General**. Dans **Workflow permissions**, coche **Read and write permissions**, puis clique sur **Save**.

### 4. Lancer le robot une première fois
1. Ouvre l'onglet **Actions**. Si GitHub te le propose, active les workflows.
2. Clique sur **Mise à jour des prix Cardmarket**, puis sur **Run workflow**.
3. Au bout d'une minute environ, une coche verte doit apparaître. Le dossier `data/` contient alors `latest.json`, `catalog.json` et `history.json`.

Si tu vois une croix rouge, clique dessus : le message indique ce qui manque, par exemple une variable ou un lien incorrect.

### 5. Mettre le site en ligne
1. Va dans **Settings > Pages**.
2. Dans **Source**, choisis **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`. Enregistre.
3. Après une ou deux minutes, ton site est en ligne à l'adresse `https://TON-PSEUDO.github.io/pokevault/`.

### 6. Relier ta collection
1. Ouvre ton site.
2. Pour reprendre ta collection actuelle, va dans **Prix Cardmarket > Ta collection en fichier**. Exporte le CSV depuis l'ancienne version, puis importe-le dans la nouvelle.
3. Dans **Prix Cardmarket**, clique sur **Relier automatiquement mes produits**. Relie à la main ceux qui restent en cliquant dessus.

C'est terminé : les prix se mettent à jour tout seuls.

## Bon à savoir

**Fréquence des mises à jour.** Cardmarket ne publie ses prix qu'une fois par jour. Le robot vérifie trois fois par jour pour ne pas rater la publication. Un passage toutes les heures n'apporterait rien de plus.

**Historique des cartes.** L'historique quotidien est gardé automatiquement pour tout le scellé. Pour tes cartes, l'appli te propose de télécharger ta liste de cartes suivies. Remplace alors le fichier `data/tracked.json` de ton dépôt par ce fichier.

**Tes données.** Ta collection est enregistrée dans le navigateur où tu utilises le site. Pour passer à un autre appareil, utilise l'export puis l'import CSV. Pour une synchronisation automatique entre ton téléphone et ton ordinateur, il faudra ajouter une base de données, par exemple Supabase.

**Robot en pause.** GitHub met parfois en pause les tâches planifiées d'un dépôt inactif depuis 60 jours. Si cela arrive, réactive le robot depuis l'onglet **Actions**.

**Conditions de Cardmarket.** Utilise ces fichiers dans le respect des conditions d'utilisation de Cardmarket.
