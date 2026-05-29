// GET /job-status?job_id=xxx
// Returns: { job }
const { getUser, json } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const { user, admin, error } = await getUser(event);
  if (error) return json(401, { error });

  const jobId = event.queryStringParameters?.job_id;
  if (!jobId) return json(400, { error: 'missing job_id' });

  const { data: job, error: jErr } = await admin
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (jErr) return json(500, { error: jErr.message });
  if (!job) return json(404, { error: 'job not found' });

  return json(200, { job });
};
