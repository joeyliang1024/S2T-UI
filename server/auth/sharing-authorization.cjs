// Authorization is stored separately from self-declared profile fields.
const key = 'sharing-authorization'
const normalize = value => ({ approved: value?.approved === true, department: typeof value?.department === 'string' ? value.department.trim().slice(0, 256) : '' })
const readSharingAuthorization = async (config, userId) => normalize(await config.get(userId, key))
const setSharingAuthorization = async (config, userId, value, adminId) => {
  if (typeof value?.approved !== 'boolean' || typeof value?.department !== 'string' || value.department.trim().length > 256) throw Object.assign(new Error('共享授權格式無效'), { status: 400 })
  const authorization = normalize(value)
  await config.put(userId, key, { ...authorization, approvedBy: adminId, updatedAt: new Date().toISOString() })
  return authorization
}
const validateSharingEnrollment = async (config, userId, scope, consent) => {
  if (!['private', 'department', 'organization'].includes(scope)) throw Object.assign(new Error('無效的聲紋共享範圍'), { status: 400 })
  if (scope === 'private') return
  if (consent !== 'true') throw Object.assign(new Error('分享聲紋前必須明確同意比對用途'), { status: 400 })
  const authorization = await readSharingAuthorization(config, userId)
  if (!authorization.approved || scope === 'department' && !authorization.department) throw Object.assign(new Error('共享聲紋需要 admin 核准組織與部門授權'), { status: 403 })
}
module.exports = { readSharingAuthorization, setSharingAuthorization, validateSharingEnrollment }
