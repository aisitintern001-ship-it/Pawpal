import { useEffect, useState, useCallback } from "react";
import { supabase } from "../supabase-client";
import { toast } from "react-hot-toast";

interface AdoptedRecord {
  post_id: number;
  post_name: string;
  image_url?: string | null;
  adopted_at?: string | null;
  adopter_id?: string | null;
  adopter_name?: string | null;
  adopter_email?: string | null;
}

export default function AdoptionManagement() {
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<AdoptedRecord[]>([]);

  const fetchAdoptions = useCallback(async () => {
    setLoading(true);
    setRecords([]); // Reset records at start
    try {
      // Try "posts" table first (same as Post Management uses), fallback to "post"
      let allPosts: any[] = [];
      let postsError: any = null;

      // First try "posts" table
      const { data: postsData, error: postsErr } = await supabase
        .from("posts")
        .select("id, name, image_url, updated_at, created_at, status")
        .order("updated_at", { ascending: false });

      if (!postsErr && postsData) {
        allPosts = postsData;
      } else {
        postsError = postsErr;
        // Try "post" table as fallback
        const { data: postData, error: postErr } = await supabase
          .from("post")
          .select("id, name, image_url, updated_at, created_at, status")
          .order("updated_at", { ascending: false });
        
        if (!postErr && postData) {
          allPosts = postData;
          postsError = null;
        } else {
          postsError = postErr || postsError;
        }
      }

      if (postsError) {
        console.error("Error fetching posts:", postsError);
        // Don't throw - just show empty state
        setRecords([]);
        setLoading(false);
        return;
      }

      // Filter for adopted posts - handle various case variations
      const adoptedPosts = allPosts.filter((p: any) => {
        const status = (p.status || "").toLowerCase().trim();
        return status === "adopted";
      });

      console.log(`Total posts fetched: ${allPosts.length}`);
      console.log(`Posts with 'adopted' status: ${adoptedPosts.length}`);
      console.log("All post statuses:", allPosts.map((p: any) => ({ id: p.id, name: p.name, status: p.status })));
      
      if (adoptedPosts.length === 0) {
        console.warn("No adopted posts found.");
        setRecords([]);
        setLoading(false);
        return;
      }

      const postIds = adoptedPosts.map((p: any) => p.id);
      
      console.log(`Found ${adoptedPosts.length} adopted posts with IDs:`, postIds);

      // Fetch adoption requests for these posts
      // Priority: Get approved requests first, then fallback to all requests for adopted posts
      let appsData: any[] | null = null;
      let appsError: any = null;
      
      // First, try to get all adoption_requests for these posts (not filtered by status)
      // This ensures we get the data even if status filtering fails
      try {
        const res = await supabase
          .from("adoption_requests")
          .select("post_id, requester_id as applicant_id, created_at, updated_at, status")
          .in("post_id", postIds as any)
          .order("updated_at", { ascending: false })
          .order("created_at", { ascending: false });
        appsData = res.data as any[] | null;
        appsError = res.error;
        
        if (appsError) {
          console.warn("Error fetching adoption_requests:", appsError);
        }
      } catch (e) {
        appsError = e;
        console.warn("Exception fetching adoption_requests:", e);
      }

      // If still no data, try adoption_applications as fallback
      if ((appsError || !appsData || appsData.length === 0)) {
        try {
          const res = await supabase
            .from("adoption_applications")
            .select("post_id, applicant_id, created_at, updated_at, status")
            .in("post_id", postIds as any)
            .order("updated_at", { ascending: false })
            .order("created_at", { ascending: false });
          appsData = res.data as any[] | null;
          appsError = res.error;
          
          if (appsError) {
            console.warn("Error fetching adoption_applications:", appsError);
          }
        } catch (e) {
          appsError = e;
          console.warn("Exception fetching adoption_applications:", e);
        }
      }

      // Log for debugging
      if (appsData && appsData.length > 0) {
        console.log("Found adoption requests/applications:", appsData.length);
      } else {
        console.warn("No adoption requests/applications found for adopted posts:", postIds);
      }

      // Don't throw error if no apps found - we'll handle it gracefully
      // PGRST116 = no rows returned (this is fine, just means no adoption requests found)
      if (appsError && appsError.code !== 'PGRST116') {
        console.warn("Error fetching adoption data (non-critical):", appsError);
        // Continue anyway - we'll show pets without adopter info
      }

      const ACCEPTED_STATUSES = ["approved", "accepted", "adopted", "completed"];

      // Build mapping postId -> approved application
      // Priority: approved requests first, then most recent if multiple approved
      const appMap = new Map<number, any>();
      
      if (!appsData || appsData.length === 0) {
        console.warn("No adoption requests/applications data available");
      } else {
        // First, collect all approved requests
        const approvedApps = (appsData || []).filter((app: any) => {
          const normalizedStatus = (app.status || "").toLowerCase();
          return ACCEPTED_STATUSES.includes(normalizedStatus);
        });

        console.log(`Found ${approvedApps.length} approved requests out of ${appsData.length} total`);

        // For each approved app, keep the most recent one per post
        approvedApps.forEach((app: any) => {
          const existing = appMap.get(app.post_id);
          if (!existing) {
            appMap.set(app.post_id, app);
          } else {
            // If there's already an approved request, keep the most recent one
            const existingDate = new Date(existing.created_at || existing.updated_at || 0);
            const appDate = new Date(app.created_at || app.updated_at || 0);
            if (appDate > existingDate) {
              appMap.set(app.post_id, app);
            }
          }
        });

        // If no approved requests found, fallback to most recent request per post
        // This handles cases where status might not be set correctly
        if (appMap.size === 0) {
          console.warn("No approved requests found, using most recent request per post");
          (appsData || []).forEach((app: any) => {
            const existing = appMap.get(app.post_id);
            if (!existing) {
              appMap.set(app.post_id, app);
            } else {
              const existingDate = new Date(existing.created_at || existing.updated_at || 0);
              const appDate = new Date(app.created_at || app.updated_at || 0);
              if (appDate > existingDate) {
                appMap.set(app.post_id, app);
              }
            }
          });
        }
      }
      
      console.log(`Mapped ${appMap.size} adoption requests to posts`);

      const adopterIds = Array.from(new Set(Array.from(appMap.values()).map((a: any) => a.applicant_id).filter(Boolean)));

      // Build a users map keyed by adopter id -> full name.
      // Preferred source: `profiles` table (has `id, full_name`).
      // Fallback: call RPC `get_user_name(user_id)` if profiles are not available.
      let usersMap: Record<string, any> = {};
      if (adopterIds.length > 0) {
        try {
          // Try profiles first (profiles.id references auth.users.id)
          const { data: profilesData, error: profilesError } = await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", adopterIds as any);

          if (profilesError) {
            console.warn("Error fetching profiles (non-critical):", profilesError);
            // Continue - we'll try other sources
          }

          if (profilesData && profilesData.length > 0) {
            usersMap = profilesData.reduce((acc: Record<string, any>, u: any) => {
              acc[u.id] = { id: u.id, full_name: u.full_name, email: null };
              return acc;
            }, {} as Record<string, any>);
          }

          // Fetch additional info from users table (for email / fallback names)
          const { data: userTableData } = await supabase
            .from("users")
            .select("user_id, full_name, email")
            .in("user_id", adopterIds as any);

          (userTableData || []).forEach((u) => {
            usersMap[u.user_id] = {
              id: u.user_id,
              full_name: u.full_name || usersMap[u.user_id]?.full_name || "Unknown",
              email: u.email || usersMap[u.user_id]?.email || null,
            };
          });

          // Fallback: call RPC `get_user_name` for ids still missing
          const missingIds = adopterIds.filter((uid) => !usersMap[uid]);
          await Promise.all(
            missingIds.map(async (uid: string) => {
              try {
                const { data: nameData, error: nameError } = await supabase.rpc("get_user_name", { user_id: uid });
                if (!nameError && nameData) {
                  usersMap[uid] = {
                    id: uid,
                    full_name: Array.isArray(nameData) ? nameData[0] : nameData,
                    email: null,
                  };
                }
              } catch (err) {
                console.warn("RPC get_user_name failed for", uid, err);
              }
            })
          );
        } catch (e) {
          // If we fail to fetch user info due to RLS, log and continue
          console.warn("Failed to fetch adopter user records:", e);
        }
      }

      // Always create records for all adopted posts, even if we can't find adoption request info
      const records: AdoptedRecord[] = adoptedPosts.map((p: any) => {
        const app = appMap.get(p.id);
        const adopterId = app?.applicant_id || null;
        const adopter = adopterId ? usersMap[adopterId] : null;
        
        // Log if we can't find adoption request for a post
        if (!app) {
          console.warn(`No adoption request found for post ${p.id} (${p.name})`);
        } else if (!adopterId) {
          console.warn(`No adopter ID found for post ${p.id} adoption request`);
        } else if (!adopter) {
          console.warn(`No adopter user info found for adopter ID ${adopterId} (post ${p.id})`);
        }
        
        // Use updated_at from the approved request as the adoption date, fallback to post updated_at
        const adoptionDate = app?.updated_at || app?.created_at || p.updated_at || p.created_at || null;
        
        return {
          post_id: p.id,
          post_name: p.name,
          image_url: p.image_url || null,
          adopted_at: adoptionDate,
          adopter_id: adopterId,
          adopter_name: adopter?.full_name || (adopterId ? "Unknown User" : "Adopter information not available"),
          adopter_email: adopter?.email || null,
        };
      });

      console.log(`Created ${records.length} adoption records`);
      console.log("Records:", records);
      setRecords(records); // Load real adoption records into the component
      setLoading(false);
    } catch (error: any) {
      console.error("Error fetching adoptions:", error);
      const errorMessage = error?.message || "Unknown error occurred";
      console.error("Full error details:", error);
      toast.error(`Failed to fetch adoption records: ${errorMessage}`);
      setRecords([]); // Set empty array on error
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAdoptions();
  }, [fetchAdoptions]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-violet-600" />
      </div>
    );
  }

  // Remove duplicate fetching logic: handled above with loading, setRecords

  return (
    <div className="p-6 relative">
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pet</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Adopter</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Adopted On</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {records.map((r) => (
              <tr key={r.post_id}>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="font-medium text-gray-900">{r.post_name}</div>
                  <div className="text-sm text-gray-500">ID: {r.post_id}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="font-medium text-gray-900">{r.adopter_name}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {r.adopted_at ? new Date(r.adopted_at).toLocaleDateString(undefined, {
                    year: 'numeric', month: 'long', day: 'numeric',
                  }) : 'N/A'}
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td colSpan={3} className="px-6 py-12 text-center text-gray-400">No adoption records found matching your filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
