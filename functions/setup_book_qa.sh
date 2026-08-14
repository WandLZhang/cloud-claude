#!/bin/bash
set -euo pipefail

# One-time infrastructure for the nightly book_qa job. Idempotent — safe to re-run.
#
# Mirrors the pattern already proven in chinese-convo-live/scripts/setup_infra.sh: Cloud Scheduler
# calls a PRIVATE gen2 function with an OIDC token minted for the compute service account, which is
# also the account the function runs as.
#
#   ./deploy.sh book_qa        # deploy the function first
#   ./setup_book_qa.sh         # then wire the schedule
#
# Kick it off by hand any time with:
#   curl -X POST -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
#        -H 'Content-Type: application/json' -d '{"dryRun":true}' \
#        https://us-east4-wz-cloud-claude.cloudfunctions.net/book_qa

PROJECT_ID="${PROJECT_ID:-wz-cloud-claude}"
REGION="${REGION:-us-east4}"
JOB="book-qa-nightly"
FN="book_qa"
# gen2 functions run on Cloud Run, which normalises the underscore: the function and its URL are
# book_qa, the backing Run service is book-qa. The invoker binding goes on the Run name.
RUN_SVC="${FN//_/-}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "== [1/4] Enable Cloud Scheduler =="
# Not previously enabled on this project — the other scheduled work lives in convo-live.
gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT_ID"

echo "== [2/4] IAM for the runtime service account =="
# It already has aiplatform.user (Vertex), firebasestorage.viewer (page photos) and
# firestore.serviceAgent — but NOT app-level Firestore write, which this job needs to store
# translations, finalize/qa records and the nightly report.
for role in roles/datastore.user roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${COMPUTE_SA}" --role="$role" --condition=None >/dev/null
  echo "   $role"
done

echo "== [3/4] Let the scheduler invoke the private function =="
gcloud run services add-iam-policy-binding "$RUN_SVC" --project "$PROJECT_ID" \
  --region="$REGION" --member="serviceAccount:${COMPUTE_SA}" --role=roles/run.invoker >/dev/null \
  || { echo "   ERROR: $FN is not deployed yet — run ./deploy.sh $FN first" >&2; exit 1; }

echo "== [4/4] Nightly schedule =="
# Midnight Eastern. The time zone is explicit because the workstation clock is UTC, so a bare cron
# expression would silently mean 00:00 UTC — 8pm the previous evening, while books are still being
# photographed.
URI="https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${FN}"
if gcloud scheduler jobs describe "$JOB" --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" --project "$PROJECT_ID" --location="$REGION" \
    --schedule="0 0 * * *" --time-zone="America/New_York" --uri="$URI" \
    --http-method=POST --message-body='{}' \
    --oidc-service-account-email="$COMPUTE_SA" --oidc-token-audience="$URI" >/dev/null
  echo "   updated $JOB"
else
  gcloud scheduler jobs create http "$JOB" --project "$PROJECT_ID" --location="$REGION" \
    --schedule="0 0 * * *" --time-zone="America/New_York" --uri="$URI" \
    --http-method=POST --message-body='{}' \
    --oidc-service-account-email="$COMPUTE_SA" --oidc-token-audience="$URI" >/dev/null
  echo "   created $JOB"
fi

echo
echo "Done. Nightly at 00:00 America/New_York -> $URI"
echo "Reports land in Firestore at chats/<uid>/qaReports/<YYYY-MM-DD>."
echo
echo "First run only — stamp the books already rebuilt by hand so the job does not re-translate them:"
echo "  gcloud scheduler jobs run $JOB --project $PROJECT_ID --location $REGION   # or:"
echo "  curl -X POST -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" \\"
echo "       -H 'Content-Type: application/json' -d '{\"backfill\":true}' $URI"
