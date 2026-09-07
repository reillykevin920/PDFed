# Paperless

A static, local-first workspace for born-digital PDFs.

## Publish on GitHub Pages

1. Create a new GitHub repository.
2. Upload everything in this folder to the repository root.
3. Open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select the `main` branch and `/ (root)`, then save.
6. Open the GitHub Pages URL GitHub provides.

That is the entire deployment. There is no Python server, Node server, database server, or build command.

PDFs opened in Paperless are processed in the browser and stored locally in that browser's IndexedDB. The hosted site does not receive the PDF files.

## Current scope

- Born-digital PDFs only
- Automatic structure detection using existing PDF bookmarks or document typography
- Reading and source views
- Section-aware search within one PDF or across the local library
- Persistent local PDF library
- Binder compiler that merges selected PDFs and creates a cover and generated index
