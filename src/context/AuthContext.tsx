import { User } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../supabase-client";

interface AuthResponse {
  success: boolean;
  error?: string;
}

interface AdoptionValidation {
  hasExperience?: string;
  stableLiving?: string;
  canAfford?: string;
  hasTime?: string;
  householdOnBoard?: string;
  hasSpace?: string;
  longTermCommitment?: string;
}

interface AuthContextType {
  user: User | null;
  role: string | null;
  signUpWithEmail: (
    email: string,
    password: string,
    role?: string,
    first_name?: string,
    last_name?: string,
    adoptionValidation?: AdoptionValidation
  ) => Promise<AuthResponse>;
  signInWithEmail: (email: string, password: string) => Promise<AuthResponse>;
  signOut: () => Promise<void>;
  resendVerificationEmail: (email: string) => Promise<AuthResponse>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null);

  const fetchUserRole = async (userId: string) => {
    const { data, error } = await supabase
      .from("users") // or 'profiles' if that's your table
      .select("role")
      .eq("user_id", userId)
      .single();
    if (!error && data) {
      setRole(data.role);
      localStorage.setItem("userRole", data.role);
    } else {
      setRole(null);
      localStorage.removeItem("userRole");
    }
  };

  useEffect(() => {
    checkUser();
    const savedRole = localStorage.getItem("userRole");
    if (savedRole) setRole(savedRole);
    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (user) {
      fetchUserRole(user.id);
    } else {
      setRole(null);
      localStorage.removeItem("userRole");
    }
  }, [user]);

  useEffect(() => {
    const insertUserIfNeeded = async () => {
      if (!user) return;
      
      console.log("User session detected, attempting to upsert user profile:", user.id);
      
      // Get adoptionValidation from localStorage (only for newly verified accounts)
      let adoptionValidation = null;
      const cached = localStorage.getItem("pendingAdoptionValidation");
      if (cached) {
        try { 
          const parsed = JSON.parse(cached);
          // Validate that it's an object with at least one property
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            // Filter out empty values
            adoptionValidation = Object.fromEntries(
              Object.entries(parsed).filter(([_, value]) => value && (typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined))
            );
            if (Object.keys(adoptionValidation).length === 0) {
              adoptionValidation = null;
            }
            console.log("Found and validated cached adoption validation:", adoptionValidation);
          } else {
            console.warn("Cached adoption validation is empty or invalid");
          }
        } catch (e) {
          console.error("Failed to parse cached adoption validation:", e);
        }
      }
      
      // Check if user already exists
      const { data: existingUser, error: checkError } = await supabase
        .from("users")
        .select("id, adoption_validation")
        .eq("id", user.id)
        .maybeSingle();
      
      if (checkError) {
        console.error("Error checking existing user:", checkError);
      }
      
      // Prepare user data - prioritize cached adoption validation if it exists
      // Only use existing adoption_validation if there's no cached one (to avoid overwriting with null)
      const finalAdoptionValidation = adoptionValidation || existingUser?.adoption_validation || null;
      
      console.log("Final adoption validation for upsert:", finalAdoptionValidation);
      
      const userData = {
        id: user.id,
        email: user.email || "",
        full_name: user.user_metadata?.full_name || user.email?.split("@")[0] || "Unknown",
        role: user.user_metadata?.role || "user",
        adoption_validation: finalAdoptionValidation,
        created_at: new Date().toISOString(),
      };
      
      console.log("Upserting user data:", userData);
      
      // Upsert user profile regardless of admin/vet verification status
      const { data: upsertData, error: upsertError } = await supabase
        .from("users")
        .upsert([userData], { onConflict: 'id' })
        .select();
      
      if (upsertError) {
        console.error('AuthProvider auto upsert error:', upsertError);
        console.error('Upsert error details:', JSON.stringify(upsertError, null, 2));
        // Try insert instead of upsert in case of conflict issues
        const { error: insertError, data: insertData } = await supabase
          .from("users")
          .insert([userData])
          .select();
        if (insertError) {
          console.error('Insert fallback also failed:', insertError);
          // As a last-resort, call server RPC to create profile (SECURITY DEFINER RPC should be installed)
          try {
            if (adoptionValidation && typeof adoptionValidation === 'object') {
              await supabase.rpc('create_user_profile_if_missing', {
                _validation: adoptionValidation,
                _full_name: userData.full_name,
                _role: userData.role,
              });
                // Also persist the structured adoption answers into rows if table exists
                try {
                  await supabase.rpc('save_adoption_validation_for_current_user', { _validation: adoptionValidation });
                } catch (innerRpcErr) {
                  console.warn('save_adoption_validation_for_current_user failed:', innerRpcErr);
                }
              if (cached) localStorage.removeItem('pendingAdoptionValidation');
            }
          } catch (rpcErr) {
            console.warn('RPC create_user_profile_if_missing failed:', rpcErr);
          }
        } else {
          console.log('Insert fallback succeeded:', insertData);
          // Clear cached adoption validation after successful insert
          if (cached) {
            localStorage.removeItem("pendingAdoptionValidation");
          }
        }
      } else {
        console.log('Upsert succeeded:', upsertData);
        // Clear cached adoption validation after successful upsert
        if (cached) {
          localStorage.removeItem("pendingAdoptionValidation");
        }
        // Also attempt RPC to ensure profiles row exists (no-op if already present)
        try {
          await supabase.rpc('create_user_profile_if_missing', {
            _validation: finalAdoptionValidation,
            _full_name: userData.full_name,
            _role: userData.role,
          });
          // Persist adoption validation into rows if available
          if (finalAdoptionValidation) {
            try {
              await supabase.rpc('save_adoption_validation_for_current_user', { _validation: finalAdoptionValidation });
            } catch (inner) {
              console.warn('save_adoption_validation_for_current_user failed after upsert:', inner);
            }
          }
        } catch (rpcErr) {
          console.warn('RPC create_user_profile_if_missing after upsert failed:', rpcErr);
        }
      }
    };
    insertUserIfNeeded();
  }, [user]);

  const checkUser = async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      setUser(session?.user ?? null);
    } catch (error) {
      console.error("Error checking user session:", error);
      setUser(null);
    }
  };

  const signUpWithEmail = async (
    email: string,
    password: string,
    role: string = "user",
    first_name?: string,
    last_name?: string,
    adoptionValidation?: AdoptionValidation
  ): Promise<AuthResponse> => {
    try {
      const fullName = first_name && last_name 
        ? `${first_name} ${last_name}` 
        : email.split("@")[0];

      // Save adoption validation to localStorage BEFORE signup
      // Ensure it's a valid object before saving
      if (adoptionValidation && typeof adoptionValidation === 'object') {
        // Filter out empty values to keep only answered questions
        const filteredValidation = Object.fromEntries(
          Object.entries(adoptionValidation).filter(([_, value]) => value && value.trim && value.trim() !== '')
        );
        
        if (Object.keys(filteredValidation).length > 0) {
          localStorage.setItem("pendingAdoptionValidation", JSON.stringify(filteredValidation));
          console.log("Saved adoption validation to localStorage:", filteredValidation);
        } else {
          console.warn("Adoption validation object is empty, not saving to localStorage");
        }
      }

      // Step 1: Sign up with Supabase
      const redirectUrl = `${window.location.origin}/verify-email`;
      console.log("Signing up user with email:", email.toLowerCase().trim());
      console.log("Email redirect URL:", redirectUrl);
      
      const { data: signUpData, error: authError } = await supabase.auth.signUp({
        email: email.toLowerCase().trim(),
        password,
        options: {
          data: {
            email: email.toLowerCase().trim(),
            full_name: fullName,
            first_name,
            last_name,
            role,
            adoption_validation: adoptionValidation || null,
          },
          emailRedirectTo: redirectUrl,
        },
      });

      console.log("Signup response:", { 
        user: signUpData?.user?.id, 
        session: !!signUpData?.session,
        error: authError?.message 
      });

      // If signup fails due to existing email or server error
      if (authError) {
        // Log full error object for diagnostics
        console.error("Signup error (full):", authError);
        const msg = authError?.message || JSON.stringify(authError);
        if (
          msg.includes("already registered") ||
          msg.includes("already exists") ||
          msg.includes("User already registered")
        ) {
          return {
            success: false,
            error: "This email is already registered. Please use the login page to sign in.",
          };
        }
        // Return the full error object stringified so UI can show more detail
        return { success: false, error: typeof authError === 'string' ? authError : JSON.stringify(authError) };
      }

      // If user was created, try to insert into users table immediately
      // This might fail due to RLS, but we'll retry after email verification
      if (signUpData?.user?.id) {
        console.log("Attempting to insert user into users table:", signUpData.user.id);
        
        // Prepare adoption validation - filter out empty values
        let finalAdoptionValidation = null;
        if (adoptionValidation && typeof adoptionValidation === 'object') {
          finalAdoptionValidation = Object.fromEntries(
            Object.entries(adoptionValidation).filter(([_, value]) => value && value.trim && value.trim() !== '')
          );
          if (Object.keys(finalAdoptionValidation).length === 0) {
            finalAdoptionValidation = null;
          }
        }
        
        console.log("Adoption validation being saved:", finalAdoptionValidation);
        
        const { error: insertError, data: insertData } = await supabase
          .from("users")
          .insert([
            {
              id: signUpData.user.id,
              email: email.toLowerCase().trim(),
              full_name: fullName,
              role,
              adoption_validation: finalAdoptionValidation,
              created_at: new Date().toISOString()
            }
          ])
          .select();
        
          if (insertError) {
          console.error("Failed to insert user profile on sign up (this is OK, will retry after verification):", insertError);
          console.error("Insert error details:", JSON.stringify(insertError, null, 2));
          // Keep adoption validation in localStorage for retry after email verification
          // Try RPC immediately so server creates the user/profile using auth.uid()
          try {
            // Call RPC regardless of whether adoption answers exist so a profiles row is created.
            await supabase.rpc('create_user_profile_if_missing', {
              _validation: finalAdoptionValidation,
              _full_name: fullName,
              _role: role,
            });
            // Persist adoption validation into rows if available (no-op if null)
            try {
              await supabase.rpc('save_adoption_validation_for_current_user', { _validation: finalAdoptionValidation });
            } catch (saveErr) {
              console.warn('save_adoption_validation_for_current_user failed after signup insert error:', saveErr);
            }
            // If RPC succeeded, clear localStorage
            localStorage.removeItem('pendingAdoptionValidation');
          } catch (rpcErr: any) {
            console.warn('RPC create_user_profile_if_missing failed after signup insert error:', rpcErr);
            // Return a clear error so the UI can show meaningful feedback.
            return { success: false, error: rpcErr?.message || 'Database error saving new user' };
          }
          } else {
          console.log("Successfully inserted user profile:", insertData);
          // Clear localStorage since we successfully saved it
          if (finalAdoptionValidation) {
            localStorage.removeItem("pendingAdoptionValidation");
          }
        }
      }

      // If user was created but no session (email confirmation required)
      if (signUpData.user && !signUpData.session) {
        return {
          success: true,
          error: "Please check your email to verify your account before signing in.",
        };
      }

      // If we have a session (email confirmation not required), user will be inserted by useEffect
      return { success: true };
    } catch (error) {
      console.error("Signup error:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred",
      };
    }
  };

  const resendVerificationEmail = async (email: string): Promise<AuthResponse> => {
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email.toLowerCase().trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/verify-email`,
        },
      });

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to resend verification email",
      };
    }
  };

  const signInWithEmail = async (
    email: string,
    password: string
  ): Promise<AuthResponse> => {
    try {
      console.log("Attempting to sign in...");
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.toLowerCase(),
        password,
      });

      if (error) {
        console.error("Sign in error:", error);
        return {
          success: false,
          error: "Invalid email or password",
        };
      }

      if (!data?.user) {
        return {
          success: false,
          error: "User not found",
        };
      }

      // Check if email is confirmed first
      if (!data.user.email_confirmed_at) {
        await supabase.auth.signOut();
        return {
          success: false,
          error: "Please verify your email address before signing in. Check your inbox for the verification link.",
        };
      }

      // Get user role and verification from users table
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("role, verified")
        .eq("user_id", data.user.id)
        .single();

      if (userError || !userData) {
        console.error("Error fetching user role:", userError);
        await supabase.auth.signOut();
        return {
          success: false,
          error: "Error fetching user account. Please contact support.",
        };
      }

      // For regular users: Block login if account is not verified by admin/vet
      // Vets and admins can always log in (they don't need approval)
      if (userData.role === "user") {
        // Check if verified field exists and is true
        if (userData.verified !== true) {
          await supabase.auth.signOut();
          return {
            success: false,
            error: "Your account is awaiting vet/admin approval. You cannot log in until your account has been verified. We'll notify you once it's approved.",
          };
        }
      }

      // Store role in localStorage
      localStorage.setItem("userRole", userData.role || "user");

      // Try adoptionValidation from localStorage (may be null for returning users)
      let adoptionValidation = null;
      const cached = localStorage.getItem("pendingAdoptionValidation");
      if (cached) {
        try {
          adoptionValidation = JSON.parse(cached);
        } catch {}
        localStorage.removeItem("pendingAdoptionValidation"); // Clean up after inserting
      }
      const { error: upsertError } = await supabase
        .from("users")
        .upsert([
          {
            id: data.user.id,
            email: data.user.email,
            role: userData?.role || "user",
            full_name: data.user.user_metadata?.full_name || data.user.email?.split("@")[0] || "Unknown",
            adoption_validation: adoptionValidation,
            created_at: new Date().toISOString(),
          }
        ], { onConflict: 'id' });
      if (upsertError) {
        console.error('Upsert error:', upsertError);
        // Fallback to server RPC to ensure adoption validation is stored
        try {
          if (adoptionValidation) {
            await supabase.rpc('create_user_profile_if_missing', {
              _validation: adoptionValidation,
              _full_name: data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || 'Unknown',
              _role: userData?.role || 'user',
            });
            try {
              await supabase.rpc('save_adoption_validation_for_current_user', { _validation: adoptionValidation });
            } catch (saveErr) {
              console.warn('save_adoption_validation_for_current_user failed on sign in upsert fallback:', saveErr);
            }
          }
        } catch (rpcErr) {
          console.warn('RPC create_user_profile_if_missing on sign in upsert failure:', rpcErr);
        }
      }

      console.log("Sign in successful");
      return {
        success: true,
      };
    } catch (error) {
      console.error("Unexpected error during sign in:", error);
      return {
        success: false,
        error: "An unexpected error occurred",
      };
    }
  };

  const signOut = async () => {
    try {
      // Clear all auth data first
      setUser(null);
      setRole(null);

      // Clear all localStorage data
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("supabase.auth.")) {
          localStorage.removeItem(key);
        }
      }
      // Also clear your custom role key
      localStorage.removeItem("userRole");

      // Kill the session
      const { error } = await supabase.auth.signOut();
      if (error) throw error;

      // Navigate to landing page
      window.location.href = "/";
    } catch (error) {
      console.error("Error during sign out:", error);
      // Force a hard refresh even on error
      window.location.href = "/";
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        role,
        signUpWithEmail,
        signInWithEmail,
        signOut,
        resendVerificationEmail,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within the AuthProvider");
  }
  return context;
};
