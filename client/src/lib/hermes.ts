export const matchesHermesProfile = (item: { profile?: string }, profile: string | null) =>
  profile === null ? !item.profile : item.profile === profile;
