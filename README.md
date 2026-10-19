# WritersLogic public records and IPFS pinning

Public identity documents, certificates, provenance indexes, and schemas, with a
small token-authenticated Cloudflare Worker for the standard IPFS Pinning Service
API. The Worker delegates storage to an existing pinning provider; it does not
run Kubo, keep a second pin database, or claim that GitHub storage is IPFS pinning.

**Current state:** public records are archived; the Worker is implemented and
tested but is not connected to a provider or deployed. No local daemon or paid
Cloudflare Containers are required by this design.

- [Canonical file directory](https://writerslogic.com/.well-known/)
- [Public file archive](public/)
- [SHA-256 and content-address catalog](public/catalog.json)
- [Company DID](https://writerslogic.com/.well-known/did.json)
- [Executive DID](https://writerslogic.com/executives/dcondrey/did.json)
- [David Condrey’s ORCID](https://orcid.org/0009-0003-1849-2963)
- [ARK assigning authority policy — NAAN 56439](https://writerslogic.com/ark-policy)

The original WritersLogic URLs remain authoritative. This repository is a public
copy, not a new DID authority. Its catalog binds each file's exact bytes to a
SHA-256 hash and a CIDv1 raw-block address. Those computed CIDs do not establish
that a block has been published to IPFS or pinned. Ordinary UnixFS file uploads
can produce a different CID; record a provider-confirmed CID separately.

Only paths in `source-paths.json` are imported. No private signing keys,
credentials, unpublished manuscripts, or Kubo repository state belong here.
Local signing keys are managed in macOS Keychain by the website repository;
server-side API credentials belong in Cloudflare secrets.

## Run checks and refresh the archive

Use Node 22 or newer:

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run types
npm run check
npm test
npm run snapshot
```

`snapshot` fetches only allowlisted public URLs from `writerslogic.com`, rejects
HTML fallback pages and PEM private keys, bounds each file to 1 MiB, and updates
the catalog. The manual **Refresh public records** GitHub workflow performs the
same operation and commits changed public files. No recurring job is enabled.

## Connect a pinning provider

Choose a provider that supports the [standard pinning API](https://ipfs.github.io/pinning-services-api-spec/).
Set `PINNING_UPSTREAM` in `wrangler.jsonc` to its HTTPS API base, without `/pins`.
For example, 4EVERLAND documents `https://api.4everland.dev` as its API base;
IPFS Cluster supplies an implementation for a separately hosted Kubo node.

Set these server-side secrets with `npx wrangler secret put NAME`:

- `PINNING_ACCESS_TOKEN`: a new, independently generated access token of at least
  32 characters for clients of the WritersLogic API.
- `PINNING_PROVIDER_TOKEN`: the provider's credential, used only between the
  Worker and the upstream service.

Never reuse a DID signing key as an API token. Never put tokens in a URL, config
file, workflow output, or public client bundle. The Worker fails closed with 503
until configured and returns 401 for invalid client credentials. It compares
credential hashes in constant time, bounds incoming JSON, validates CIDs,
streams provider responses, and does not follow provider redirects.

```sh
npm run check
npm test
npx wrangler deploy --dry-run
npm run deploy
```

The custom domain `pins.writerslogic.com` can be attached after a real provider
is configured and a create/status/delete round trip passes. No DNS route is
claimed before that check.

Supported routes are `GET /pins`, `POST /pins`, `GET /pins/{requestid}`,
`POST /pins/{requestid}` (replacement), and `DELETE /pins/{requestid}`. JSON pin
requests may be up to 64 KiB. Browser CORS access is restricted to
`writerslogic.com` and `writersproof.com`; every pin request still needs the
client Bearer token. `GET /` advertises the public identity links and configuration
state without disclosing secrets.

A pin request refers to an existing IPFS CID. It does not upload a GitHub file
or make unpublished bytes available to the IPFS network. Public records must be
uploaded through the selected provider before their actual CIDs are pinned.
Provider quotas and feature availability still apply. A free storage plan does
not necessarily include standard remote pinning: Pinata's pricing currently
lists that API outside its free tier. 4EVERLAND requires account activation for
API access, including a blockchain gas fee. No paid plan or account activation
has been performed for this repository.

References: [4EVERLAND API](https://docs.4everland.org/storage/4ever-pin/pinning-services-api),
[4EVERLAND registration](https://docs.4everland.org/get-started/quick-start-guide/registration),
[Pinata plans](https://pinata.cloud/pricing),
[IPFS Cluster API](https://ipfscluster.io/documentation/reference/pinsvc_api/).
