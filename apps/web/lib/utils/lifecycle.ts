export type LifecycleStage =
  | 'active_student'
  | 'approaching_graduation'
  | 'post_graduation_unverified'
  | 're_verification_pending'
  | 'converted'
  | 'churned'
  | 'flagged_review'
  | 'dismissed'

export function computeLifecycleStage(graduationDate: string | null | undefined): LifecycleStage {
  if (!graduationDate) return 'active_student'
  const grad = new Date(graduationDate)
  if (isNaN(grad.getTime())) return 'active_student'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.floor((grad.getTime() - today.getTime()) / 86_400_000)
  if (diffDays > 90) return 'active_student'
  if (diffDays >= 0) return 'approaching_graduation'
  return 'post_graduation_unverified'
}

export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  active_student: 'Active Student',
  approaching_graduation: 'Approaching Graduation',
  post_graduation_unverified: 'Post-Graduation',
  re_verification_pending: 'Re-Verification Pending',
  converted: 'Converted',
  churned: 'Churned',
  flagged_review: 'Flagged',
  dismissed: 'Dismissed',
}

export const LIFECYCLE_COLORS: Record<LifecycleStage, string> = {
  active_student: 'bg-green-100 text-green-700',
  approaching_graduation: 'bg-yellow-100 text-yellow-700',
  post_graduation_unverified: 'bg-red-100 text-red-700',
  re_verification_pending: 'bg-purple-100 text-purple-700',
  converted: 'bg-blue-100 text-blue-700',
  churned: 'bg-gray-100 text-gray-500',
  flagged_review: 'bg-orange-100 text-orange-700',
  dismissed: 'bg-gray-100 text-gray-500',
}