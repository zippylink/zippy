# Zippy — Tilt entrypoint. Boot with:  ./tilt_up.sh   (never `tilt up` directly —
# the script pins the Tilt UI port so multiple projects coexist).
#
# Real logic lives in .devops/Tiltfile (loaded via load_dynamic from root).

load_dynamic('.devops/Tiltfile')

# Dashboard "title" — a banner resource in a digit-prefixed label group headlines
# the sidebar with the project name (Tilt has no native project-title setting).
local_resource(
    'ZIPPY',
    cmd='echo "⚡ Zippy — short links that open the native app · ./tilt_up.sh"',
    labels=['0-ZIPPY'],
)
